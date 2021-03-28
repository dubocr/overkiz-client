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
    oid = '';
    deviceURL = '';
    label = '';
    widget = '';
    uiClass = '';
    controllableName = '';
    states: Array<State> = [];

    public definition: Definition = { commands: [] };

    public parent: Device | undefined;
    public sensors: Device[] = [];

    get uuid() {
        return validateUUID(this.oid) ? this.oid : UUIDv5(this.oid, '6ba7b812-9dad-11d1-80b4-00c04fd430c8');
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

    get serialNumber() {
        return this.uuid;
    }

    get address() {
        const pos = this.deviceURL.lastIndexOf('/');
        if(pos === -1) {
            return this.deviceURL;
        } else {
            return this.deviceURL.substring(pos+1);
        }
    }

    get protocol(): string {
        return this.controllableName.split(':').shift() || '';
    }

    hasCommand(name: string): boolean {
        return this.definition.commands.find((command: CommandDefinition) => command.commandName === name) !== undefined;
    }

    hasState(name: string): boolean {
        return this.states.find((state: State) => state.name === name) !== undefined;
    }

    hasSensor(widget: string): boolean {
        return this.sensors.find((sensor) => sensor.widget === widget) !== undefined;
    }

    isMainDevice() {
        return this.componentId === 1;
    }

    isSubDevice(parent: Device | null) {
        switch(this.widget) {
            case 'TemperatureSensor': // Outdoor sensor for PassAPC
                if(parent !== null) {
                    switch(parent.widget) {
                        case 'AtlanticPassAPCBoiler':
                        case 'AtlanticPassAPCDHW':
                            return true; // Exterior temperature sensor for boiler
                    }
                }
                return false;
            default:
                return !this.widget.endsWith('Sensor');
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
}