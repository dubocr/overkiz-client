import { EventEmitter } from 'events';
import { Device, ExecutionState } from '.';
import ActionGroup from './models/ActionGroup';
import Execution, { ExecutionError } from './models/Execution';
import RestClient from './RestClient';

export let Log;

enum ApiEndpoint {
	'Cozytouch' = 'https://ha110-1.overkiz.com/enduser-mobile-web/enduserAPI',
	'TaHoma' = 'https://tahomalink.com/enduser-mobile-web/enduserAPI',
	'Connexoon' = 'https://tahomalink.com/enduser-mobile-web/enduserAPI',
	'Connexoon RTS' = 'https://ha201-1.overkiz.com/enduser-mobile-web/enduserAPI',
	'Rexel' = 'https://ha112-1.overkiz.com/enduser-mobile-web/enduserAPI',
	'Debug' = 'https://dev.duboc.pro/api/overkiz'
}

export default class OverkizClient extends EventEmitter {
    debug: boolean;
    apiEndpoint: string;
    execPollingPeriod;
    pollingPeriod;
    refreshPeriod;
    service;
    server;
    listenerId: null|number = null;
    executionPool: Execution[] = [];
    stateChangedEventListener = null;
    
    restClient: RestClient;

    devices: Array<Device> = new Array<Device>();

    refreshPollingId;
    eventPollingId;

    constructor(log, config) {
        super();
        Log = log;

        // Default values
        this.debug = config['debug'] || false;
        this.execPollingPeriod = config['execPollingPeriod'] || 2; // Poll for execution events every 2 seconds by default
        this.pollingPeriod = config['pollingPeriod'] || 60; // Don't continuously poll for events by default (in seconds)
        this.refreshPeriod = config['refreshPeriod'] || (60 * 30); // Refresh device states every 30 minutes by default (in seconds)
        this.service = config['service'] || 'TaHoma';

        if (!config['user'] || !config['password']) {
            throw new Error('You must provide credentials (\'user\'/\'password\')');
        }
        this.apiEndpoint = ApiEndpoint[this.service];
        if (!this.apiEndpoint) {
            throw new Error('Invalid service name \''+this.service+'\'');
        }
        this.restClient = new RestClient(config['user'], config['password'], this.apiEndpoint);

        
        this.listenerId = null;

        this.setRefreshPollingPeriod(this.refreshPeriod);
        this.setEventPollingPeriod(this.pollingPeriod);
    }

    hasExecution() {
        return Object.keys(this.executionPool).length > 0;
    }

    async getDevices(): Promise<Array<Device>> {
        let lastDevice: Device|null = null;
        const mainDevices = new Array<Device>();
        const devices = (await this.restClient.get('/setup/devices')).map((device) => Object.assign(new Device(), device));
        devices.forEach((device) => {
            if(this.devices[device.deviceURL]) {
                //Object.assign(this.devices[device.deviceURL], device);
            } else {
                this.devices[device.deviceURL] = device;
            }
            if(device.isMainDevice()) {
                lastDevice = device;
                mainDevices.push(device);
            } else if(lastDevice != null) {
                lastDevice.addSensor(device);
            }
        });
        return mainDevices;
    }

    async getActionGroups(): Promise<Array<ActionGroup>> {
        return this.restClient.get('/actionGroups').then((result) => result.map((data) => data as ActionGroup));
    }

    private registerListener() {
        return this.restClient.post('/events/register')
            .then((data) => {
                this.listenerId = data.id;
            });
    }

    private async unregisterListener() {
        return this.restClient.post('/events/' + this.listenerId + '/unregister')
            .then(() => {
                this.listenerId = null;
            });
    }

    refreshStates() {
        return this.restClient.put('/setup/devices/states/refresh');
    }

    requestState(deviceURL, state) {
        return this.restClient.get('/setup/devices/' + encodeURIComponent(deviceURL) + '/states/' + encodeURIComponent(state))
            .then((data) => data.value);
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
        //Log(execution);
        if(this.executionPool.length >= 10) {
            // Avoid EXEC_QUEUE_FULL (max 10 commands simultaneous)
            // Postpone in 10 sec
            await this.delay(10 * 1000);
        }
        try {
            //Log(JSON.stringify(execution));
            this.setEventPollingPeriod(this.execPollingPeriod);
            const data = await this.restClient.post('/exec/'+oid, execution);
            this.executionPool[data.execId] = execution;
            return data.execId;
        } catch(error) {
            throw new ExecutionError(ExecutionState.FAILED, error);
        }
    }

    setRefreshPollingPeriod(period: number) {
        if(this.refreshPollingId != null) {
            clearInterval(this.refreshPollingId);
        }
        if(period > 0) {
            this.refreshPollingId = setInterval(this.refreshAll.bind(this), period * 1000);
        }
    }

    async setEventPollingPeriod(period: number) {
        if(this.eventPollingId != null) {
            clearInterval(this.eventPollingId);
        }
        if(period > 0) {
            if(this.listenerId === null) {
                await this.registerListener();
            }
            this.eventPollingId = setInterval(this.fetchEvents.bind(this), period * 1000);
        }
    }

    async refreshAll() {
        if(this.restClient.logged) {
            try {
                const data = await this.refreshStates();
                setTimeout(async () => {
                    (await this.getDevices()).forEach((newDevice) => {
                        const device = this.devices[newDevice.deviceURL];
                        if(device) {
                            newDevice.states.forEach(state => {
                                const s = device.getState(state.name);
                                if(s) {
                                    s.value = state.value;
                                }
                            });
                            device.emit('states', newDevice.states);
                        }
                    });
                }, 10 * 1000); // Read devices states after 10s
            } catch(error) {
                Log('Error: ' + error);
            }
        } else {
            Log('Refresh Polling - Not logged in');
        }
    }

    async fetchEvents() {
        if(!this.restClient.logged) {
            console.log('Event Polling - Not logged in');
            return;
        }

        try {
            if(this.listenerId === null) {
                await this.registerListener();
            }
            
            const data = await this.restClient.post('/events/' + this.listenerId + '/fetch');
            for (const event of data) {
                //Log(event);
                //console.log(event);
                if (event.name === 'DeviceStateChangedEvent') {
                    const device = this.devices[event.deviceURL];
                    event.deviceStates.forEach(state => {
                        const s = device.getState(state.name);
                        if(s) {
                            s.value = state.value;
                        }
                    });
                    device.emit('states', event.deviceStates);
                } else if (event.name === 'ExecutionStateChangedEvent') {
                    //Log(event);
                    const execution = this.executionPool[event.execId];
                    if (execution) {
                        execution.onStateUpdate(event.newState, event);
                        //cb(event.newState, event.failureType === undefined ? null : event.failureType, event);
                        if (event.timeToNextState === -1) { // No more state expected for this execution
                            delete this.executionPool[event.execId];
                            if(!this.hasExecution()) { // Update polling frequency when no more execution
                                this.setEventPollingPeriod(this.pollingPeriod);
                            }
                        }
                    }
                }
            }
        } catch(error) {
            console.log('Event Polling - Error with listener ' + this.listenerId);
            console.log(error);
            this.listenerId = null;
        }
    }

    private async delay(duration) {
        return new Promise(resolve => setTimeout(resolve, duration));
    }
}
