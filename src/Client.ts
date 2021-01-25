import axios from 'axios';
import { default as events, EventEmitter } from 'events';
import pollingtoevent from 'polling-to-event';
import { URLSearchParams } from 'url';
import Device from './Device';
import RestClient from './RestClient';

let Log;

export class ExecutionError extends Error {
    public readonly state;
    constructor(state, error) {
        super(error);
        this.state = state;
    }
}

export interface ExecutionStateEvent {
    readonly timestamp: number;
    readonly setupOID;
    readonly execId;
    readonly newState: ExecutionState;
    readonly ownerKey;
    readonly type: number;
    readonly subType: number;
    readonly oldState: ExecutionState;
    readonly timeToNextState: number;
    readonly name;
}

export class Command {
    type: number = 1;
    name: string = '';
    parameters: unknown[] = [];

    constructor(name, parameters) {
        this.name = name;
        if (typeof(parameters)==='undefined') {
            parameters = [];
        }
        if (!Array.isArray(parameters)) {
            parameters = [parameters];
        }
        this.parameters = parameters;
    }
}

export class Action extends EventEmitter {
    public deviceURL;
    public commands: Command[] = [];

    constructor(public readonly label: string, public highPriority: boolean) {
        super();
    }

    toJSON() {
        return {
            deviceURL: this.deviceURL,
            commands: this.commands,
        };
    }
}

export interface ActionGroup {
    oid: string;
    label: string;
    actions: Action[];
    metadata: string;
}

export class Execution {
    private timeout;

    public label = '';
    public actions: Action[] = [];
    public metadata = null;

    addAction(action: Action) {
        this.label = this.actions.length === 0 ? action.label : 'Execute scene (' + this.actions.length + ' devices) - HomeKit';
        this.actions.push(action);
    }

    onStateUpdate(state, event) {
        if(event.failureType && event.failedCommands) {
            this.actions.forEach((action) => {
                const failure = event.failedCommands.find((c) => c.deviceURL === action.deviceURL);
                if(failure) {
                    action.emit('state', ExecutionState.FAILED, failure);
                } else {
                    action.emit('state', ExecutionState.COMPLETED);
                }
            });
        } else {
            this.actions.forEach((action) => action.emit('state', state, event));
        }
    }

    hasPriority() {
        return this.actions.find((action) => action.highPriority) ? true : false;
    }
}

export enum ExecutionState {
    INITIALIZED = 'INITIALIZED',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED'
}

enum Server {
	'Cozytouch' = 'ha110-1.overkiz.com',
	'TaHoma' = 'tahomalink.com',
	'Connexoon' = 'tahomalink.com',
	'Connexoon RTS' = 'ha201-1.overkiz.com',
	'Rexel' = 'ha112-1.overkiz.com'
}

export default class OverkizClient extends events.EventEmitter {
    debug: boolean;
    debugUrl: string;
    execPollingPeriod;
    pollingPeriod;
    refreshPeriod;
    service;
    server;
    listenerId: null|number = null;
    executionPool: Execution[] = [];
    stateChangedEventListener = null;
    execution: Execution = new Execution();

    executionTimeout;
    restClient: RestClient;

    devices: Array<Device> = new Array<Device>();

    refreshPollingId;
    eventPollingId;

    constructor(log, config) {
        super();
        Log = log;

        // Default values
        this.debug = config['debug'] || false;
        this.debugUrl = config['debugUrl'] || false;
        this.execPollingPeriod = config['execPollingPeriod'] || 2; // Poll for execution events every 2 seconds by default
        this.pollingPeriod = config['pollingPeriod'] || 0; // Don't continuously poll for events by default
        this.refreshPeriod = config['refreshPeriod'] || (60 * 30); // Refresh device states every 30 minutes by default
        this.service = config['service'] || 'TaHoma';

        if (!config['user'] || !config['password']) {
            throw new Error('You must provide credentials (\'user\'/\'password\')');
        }
        this.server = Server[this.service];
        if (!this.server) {
            throw new Error('Invalid service name \''+this.service+'\'');
        }
        const baseUrl = this.debugUrl ? this.debugUrl : 'https://' + this.server + '/enduser-mobile-web/enduserAPI';
        this.restClient = new RestClient(config['user'], config['password'], baseUrl);

        
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
        const devices = (await this.restClient.get('/setup/devices')).map((device) => Object.assign(new Device(this), device));
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

    private async registerListener() {
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

    cancelCommand(execId) {
        return this.restClient.delete('/exec/current/setup/' + execId);
    }

    /*
    	action: The action to execute
    */
    public executeAction(action) {
        this.execution.addAction(action);
        clearTimeout(this.executionTimeout);
        return new Promise((resolve, reject) => {
            this.executionTimeout = setTimeout(() => {
                this.execute(this.execution.hasPriority() ? 'apply/highPriority' : 'apply', this.execution).then(resolve).catch(reject);
                this.execution = new Execution();
            }, 100);
        });
    }

    /*
    	oid: The command OID or 'apply' if immediate execution
    	execution: Body parameters
    	callback: Callback function executed when command sended
    */
    execute(oid, execution) {
        if(this.executionPool.length >= 10) {
            // Avoid EXEC_QUEUE_FULL (max 10 commands simultaneous)
            setTimeout(this.execute.bind(this), 10 * 1000, oid, execution); // Postpone in 10 sec
            return;
        }
        //Log(JSON.stringify(execution));
        return this.restClient.post('/exec/'+oid, execution)
            .then((data) => {
                this.executionPool[data.execId] = execution;
                this.setEventPollingPeriod(this.execPollingPeriod);
                return data.execId;
            })
            .catch((error) => {
                throw new ExecutionError(ExecutionState.FAILED, error);
            });
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
                if (event.name === 'DeviceStateChangedEvent') {
                    const device = this.devices[event.deviceURL];
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
}
