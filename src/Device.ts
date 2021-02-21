import Client, { default as OverkizClient, Action, Command } from './Client';
import { EventEmitter } from 'events';
import { v5 as UUIDv5, validate as validateUUID } from 'uuid';

export interface State {
    name: string;
    type: number;
    value: string;
}

export interface CommandDefinition {
    commandName: string;
    nparams: number;
}

export interface Definition {
    commands: CommandDefinition[];
}

export default class Device extends EventEmitter {

    private api: Client;

    oid: string = '';
    deviceURL: string = '';
    label: string = '';
    widget: string = '';
    uiClass: string = '';
    controllableName: string = '';
    states: Array<State> = [];

    public definition: Definition = { commands: [] };

    public sensors: Device[] = [];
    private executionId;

    constructor(api: Client) {
        super();
        this.api = api;
    }

    get uuid() {
        return validateUUID(this.oid) ? this.oid : UUIDv5(this.oid, '6ba7b812-9dad-11d1-80b4-00c04fd430c8');
    }

    get serialNumber() {
        return this.deviceURL;
    }

    get componentId() {
        const pos = this.deviceURL.indexOf('#');
        if(pos === -1) {
            return 1;
        } else {
            return parseInt(this.deviceURL.substring(pos+1));
        }
    }

    get baseUrl() {
        const pos = this.deviceURL.indexOf('#');
        if(pos === -1) {
            return this.deviceURL;
        } else {
            return this.deviceURL.substring(0, pos);
        }
    }

    get manufacturer() {
        const manufacturer = this.get('core:ManufacturerNameState');
        return manufacturer !== null ? manufacturer : 'Somfy';
    }

    get model() {
        const model = this.get('core:ModelState');
        return model !== null ? model : this.uiClass;
    }

    hasCommand(name: string): boolean {
        return this.definition.commands.find((command: CommandDefinition) => command.commandName === name) !== undefined;
    }

    hasSensor(widget: string): boolean {
        return this.sensors.find((sensor) => sensor.widget === widget) !== undefined;
    }

    isMainDevice() {
        if(this.componentId === 1) {
            return true;
        } else {
            switch(this.widget) {
                case 'AtlanticPassAPCDHW':
                case 'AtlanticPassAPCHeatingZone':
                case 'AtlanticPassAPCHeatingAndCoolingZone':
                    return true;
            }
        }
    }

    addSensor(device: Device) {
        this.sensors.push(device);
    }

    getState(stateName) {
        if(this.states !== null) {
            for (const state of this.states) {
                if (state.name === stateName) {
                    return state;
                }
            }
        }
        return null;
    }

    get(stateName) {
        if(this.states !== null) {
            for (const state of this.states) {
                if (state.name === stateName) {
                    return state.value;
                }
            }
        }
        return null;
    }

    get isIdle() {
        return !(this.executionId in this.api.executionPool);
    }

    isCommandInProgress() {
        return (this.executionId in this.api.executionPool);
    }

    cancelCommand() {
        this.api.cancelCommand(this.executionId);
    }

    executeCommands(title, commands) {
        if (this.isCommandInProgress()) {
            this.cancelCommand();
        }

        title = this.label + ' - ' + title;
        const highPriority = this.states['io:PriorityLockLevelState'] ? true : false;
        const action = new Action(title, highPriority);
        action.deviceURL = this.deviceURL;
        action.commands = commands;

        return this.api.executeAction(action).then((executionId) => {
            this.executionId = executionId;
            return action;
        });
    }
}