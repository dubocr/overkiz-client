import { EventEmitter } from 'events';
import Device from './models/Device';
import ActionGroup from './models/ActionGroup';
import { State } from './models/Device';
import Execution, { ExecutionState, ExecutionError } from './models/Execution';
import RestClient, { ApiEndpoint, JWTApiEndpoint, LocalApiEndpoint } from './RestClient';
import Location from './models/Location';

export let logger;

const EXEC_TIMEOUT = 2 * 60 * 1000;


const endpoints = {
    local: new LocalApiEndpoint(),
    tahoma: new ApiEndpoint('https://ha101-1.overkiz.com/enduser-mobile-web/enduserAPI'),
    tahoma_switch: new ApiEndpoint('https://ha101-1.overkiz.com/enduser-mobile-web/enduserAPI'),
    connexoon: new ApiEndpoint('https://ha101-1.overkiz.com/enduser-mobile-web/enduserAPI'),
    connexoon_rts: new ApiEndpoint('https://ha201-1.overkiz.com/enduser-mobile-web/enduserAPI'),
    cozytouch: new JWTApiEndpoint(
        'https://ha110-1.overkiz.com/enduser-mobile-web/enduserAPI',
        'https://api.groupe-atlantic.com/token',
        'https://api.groupe-atlantic.com/gacoma/gacomawcfservice/accounts/jwt',
        'czduc0RZZXdWbjVGbVV4UmlYN1pVSUM3ZFI4YTphSDEzOXZmbzA1ZGdqeDJkSFVSQkFTbmhCRW9h',
    ),
    rexel: new ApiEndpoint('https://ha112-1.overkiz.com/enduser-mobile-web/enduserAPI'),
    flexom: new ApiEndpoint('https://ha108-1.overkiz.com/enduser-mobile-web/enduserAPI'),
    debug: new ApiEndpoint('https://dev.duboc.pro/api/overkiz'),
};

export default class OverkizClient extends EventEmitter {
    private restClient: RestClient;

    private service: string;

    private fetchLock = false;
    private refreshLock = false;
    private executionPool: Execution[] = [];

    private devices: Array<Device> = new Array<Device>();

    private pollingPeriod: number;
    private refreshPeriod: number;
    private execPollingPeriod: number;
    private eventPollingPeriod = 0;

    private eventPollingId: NodeJS.Timeout | null = null;
    private refreshPollingId: NodeJS.Timeout | null = null;
    private listenerId: null | string = null;

    constructor(public readonly log, public readonly config) {
        super();
        logger = Object.assign({}, log);
        logger.debug = (...args) => {
            config['debug'] ? log.info('\x1b[90m', ...args) : log.debug(...args);
        };

        // Default values
        this.execPollingPeriod = config['execPollingPeriod'] || 5; // Poll for execution events every 5 seconds by default (in seconds)
        this.pollingPeriod = config['pollingPeriod'] || 60; // Poll for events every 60 seconds by default (in seconds)
        this.refreshPeriod = (config['refreshPeriod'] || 30) * 60; // Refresh device states every 30 minutes by default (in minutes)
        this.service = config['service'] || 'tahoma';

        if (!config['user'] || !config['password']) {
            throw new Error('You must provide credentials (user / password)');
        }
        const apiEndpoint = endpoints[this.service.toLowerCase()];
        if (!apiEndpoint) {
            throw new Error('Invalid service name: ' + this.service);
        }
        this.restClient = new RestClient(config['user'], config['password'], apiEndpoint, config['proxy']);


        this.listenerId = null;

        this.restClient.on('connect', () => {
            this.setRefreshPollingPeriod(this.refreshPeriod);
            this.setEventPollingPeriod(this.pollingPeriod);
        });
        this.restClient.on('disconnect', () => {
            this.listenerId = null;
            this.setRefreshPollingPeriod(0);
            this.setEventPollingPeriod(0);
        });
    }

    public hasExecution(execId?: string) {
        if (execId) {
            return execId in this.executionPool;
        } else {
            return Object.keys(this.executionPool).length > 0;
        }
    }

    public async getDevices(): Promise<Array<Device>> {
        let lastMainDevice: Device | null = null;
        let lastDevice: Device | null = null;
        const physicalDevices = new Array<Device>();
        const devices = (await this.restClient.get('/setup/devices')).map((device) => Object.assign(new Device(), device));
        devices.forEach((device) => {
            if (this.devices[device.deviceURL]) {
                //Object.assign(this.devices[device.deviceURL], device);
            } else {
                this.devices[device.deviceURL] = device;
            }
            if (device.isMainDevice()) {
                lastMainDevice = device;
                lastDevice = device;
                physicalDevices.push(device);
            } else {
                if (lastDevice !== null && device.isSensorOf(lastDevice)) {
                    lastDevice.addSensor(device);
                } else if (lastMainDevice !== null && device.isSensorOf(lastMainDevice)) {
                    lastMainDevice.addSensor(device);
                } else {
                    lastDevice = device;
                    device.parent = lastMainDevice;
                    physicalDevices.push(device);
                }
            }
        });
        return physicalDevices;
    }

    public async refreshDevices() {
        const devices = await this.getDevices();
        devices.forEach((freshDevice) => {
            const device = this.devices[freshDevice.deviceURL];
            if (device) {
                device.updateStates(freshDevice.states);
            }
        });
    }

    public async getSetupLocation(): Promise<Location> {
        return await this.restClient.get('/setup/location') as Location;
    }

    public async getActionGroups(): Promise<Array<ActionGroup>> {
        return this.restClient.get('/actionGroups').then((result) => result.map((data) => data as ActionGroup));
    }

    private async registerListener() {
        if (this.listenerId === null) {
            //logger.debug('Registering event listener...');
            const data = await this.restClient.post('/events/register');
            this.listenerId = data.id;
        }
    }

    private async unregisterListener() {
        if (this.listenerId !== null) {
            //logger.debug('Unregistering event listener...');
            await this.restClient.post('/events/' + this.listenerId + '/unregister');
            this.listenerId = null;
        }
    }

    async refreshAllStates(devices: Array<string> = []) {
        this.refreshLock = true;
        await this.restClient.post('/setup/devices/states/refresh', devices);

        // In case 'RefreshAllDevicesStatesCompletedEvent' was not triggered avec 15 sec, refresh manually
        setTimeout(() => {
            if(this.refreshLock) {
                this.refreshLock = false;
                this.refreshDevices().catch((error) => logger.error(error));
            }
        }, 30 * 1000);
    }

    async refreshDeviceStates(deviceURL: string) {
        await this.restClient.post('/setup/devices/' + encodeURIComponent(deviceURL) + '/states/refresh');
    }

    async getState(deviceURL, state) {
        const data = await this.restClient.get('/setup/devices/' + encodeURIComponent(deviceURL) + '/states/' + encodeURIComponent(state));
        return data.value;
    }

    async getStates(deviceURL): Promise<Array<State>> {
        const states = await this.restClient.get('/setup/devices/' + encodeURIComponent(deviceURL) + '/states');
        return states;
    }

    async cancelExecution(execId) {
        return await this.restClient.delete('/exec/current/setup/' + execId);
    }

    /*
        oid: The command OID or 'apply' if immediate execution
        execution: Body parameters
        callback: Callback function executed when command sended
    */
    async execute(oid, execution) {
        //logger.debug(JSON.stringify(execution));
        if (this.executionPool.length >= 10) {
            // Avoid EXEC_QUEUE_FULL (max 10 commands simultaneous)
            // Postpone in 10 sec
            await this.delay(10 * 1000);
            return await this.execute(oid, execution);
        }
        try {
            // Prepare listener
            await this.registerListener().catch((error) => logger.error(error));

            const data = await this.restClient.post('/exec/' + oid, execution);
            this.executionPool[data.execId] = execution;

            // Update event poller for execution monitoring
            this.setEventPollingPeriod(this.execPollingPeriod);

            // Auto remove execution in case of timeout (eg: listener event missed, listener registration fails)
            setTimeout(() => {
                const execution = this.executionPool[data.execId];
                if (execution) {
                    execution.onStateUpdate(ExecutionState.TIMED_OUT, null);
                    delete this.executionPool[data.execId];
                }
            }, EXEC_TIMEOUT);

            return data.execId;
        } catch (error) {
            throw new ExecutionError(ExecutionState.FAILED, error);
        }
    }

    async setDeviceName(deviceURL, label) {
        await this.restClient.put(`/setup/devices/${encodeURIComponent(deviceURL)}/${label}`);
    }

    private setRefreshPollingPeriod(period: number) {
        // Clear previous task
        if (this.refreshPollingId) {
            clearInterval(this.refreshPollingId);
            this.refreshPollingId = null;
        }
        if (period > 0) {
            this.refreshPollingId = setInterval(this.refreshTask.bind(this), period * 1000);
        }
    }

    private setEventPollingPeriod(period: number) {
        if (period !== this.eventPollingPeriod) {
            this.eventPollingPeriod = period;

            // Clear previous task
            if (this.eventPollingId) {
                clearInterval(this.eventPollingId);
                this.eventPollingId = null;
            }

            if (period > 0) {
                logger.debug('Change event polling period to ' + period + ' sec');
                this.eventPollingId = setInterval(this.pollingTask.bind(this), period * 1000);
            } else {
                logger.debug('Disable event polling');
            }
        }
    }

    private async refreshTask() {
        try {
            //logger.debug('Refresh all devices');
            await this.refreshAllStates();
        } catch (error) {
            logger.error(error);
        }
    }

    private async pollingTask() {
        if (this.eventPollingPeriod !== this.pollingPeriod && !this.hasExecution()) {
            // Restore default polling frequency if no more execution in progress
            this.setEventPollingPeriod(this.pollingPeriod);
        } else if (!this.fetchLock) {
            // Execute task if not already running
            this.fetchLock = true;
            await this.fetchEvents();
            this.fetchLock = false;
        }
    }

    private async fetchEvents() {
        try {
            await this.registerListener();
            //logger.debug('Polling events...');
            const data = await this.restClient.post('/events/' + this.listenerId + '/fetch');
            for (const event of data) {
                //logger.log(event);
                if (event.name === 'DeviceStateChangedEvent') {
                    const device = this.devices[event.deviceURL];
                    device.updateStates(event.deviceStates);
                } else if (event.name === 'ExecutionStateChangedEvent') {
                    const execution = this.executionPool[event.execId];
                    if (execution) {
                        execution.onStateUpdate(event.newState, event);
                        if (event.timeToNextState === -1) {
                            // No more state expected for this execution
                            delete this.executionPool[event.execId];
                        }
                    }
                } else if (event.name === 'RefreshAllDevicesStatesCompletedEvent') {
                    this.refreshLock = false;
                    logger.debug('Refresh all states completed');
                    this.refreshDevices();
                }
            }
        } catch (error: any) {
            logger.error('Polling error -', error);
            if (this.listenerId === null && (error.includes('NOT_REGISTERED') || error.includes('UNSPECIFIED_ERROR'))) {
                this.listenerId = null;
            }
            // Will lock the poller for 10 sec in case of error
            await this.delay(10 * 1000);
        }
    }

    private async delay(duration) {
        return new Promise(resolve => setTimeout(resolve, duration));
    }

    public async createLocalApiToken(gatewayPin: string) {
        const data = await this.restClient.get('config/' + gatewayPin + '/local/tokens/generate');
        logger.debug(data);
        const resp = await this.restClient.post('config/' + gatewayPin + '/local/tokens', {
            'label': 'Homebridge-tahoma local API',
            'token': data.token,
            'scope': 'devmode',
        });
        logger.debug(resp);
        return data.token;
    }

    public async getLocalApiTokens(gatewayPin: string) {
        return await this.restClient.get('config/' + gatewayPin + '/local/tokens/devmode');
    }
}
