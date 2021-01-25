import Client, { default as OverkizClient, Action } from './Client';
import { EventEmitter } from 'events';

export interface State {
    name: string;
    type: number;
    value: string;
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

    public definition = { commands: [] };

    public sensors: Device[] = [];
    private executionId;

    constructor(api: Client) {
        super();
        this.api = api;
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
        const manufacturer = this._look_state('core:ManufacturerNameState');
        return manufacturer !== null ? manufacturer : 'Somfy';
    }

    get model() {
        const model = this._look_state('core:ModelState');
        return model !== null ? model : this.uiClass;
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

    _look_state(stateName) {
        if(this.states !== null) {
            for (const state of this.states) {
                if (state.name === stateName) {
                    return state.value;
                }
            }
        }
        return null;
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