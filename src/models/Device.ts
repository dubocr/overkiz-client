import { EventEmitter } from 'events';
import { v5 as UUIDv5, validate as validateUUID } from 'uuid';

export interface State {
    name: string;
    type: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
}

export interface CommandDefinition {
    commandName: string;
    nparams: number;
}

export interface Definition {
    type: string;
    widgetName: string;
    uiClass: string;
    commands: CommandDefinition[];
}

export default class Device extends EventEmitter {
    oid = '';
    deviceURL = '';
    label = '';
    controllableName = '';
    states: Array<State> = [];

    pendingUpdate = new Map<string, State>();
    pendingUpdateTimer;

    public definition: Definition = { type: '', widgetName: '', uiClass: '', commands: [] };

    public parent: Device | undefined;
    public sensors: Device[] = [];

    get uuid() {
        if (this.oid && this.oid.length > 0) {
            return validateUUID(this.oid) ? this.oid : UUIDv5(this.oid, '6ba7b812-9dad-11d1-80b4-00c04fd430c8');
        } else {
            return UUIDv5(this.deviceURL, '6ba7b812-9dad-11d1-80b4-00c04fd430c8');
        }
    }

    get componentId() {
        const pos = this.deviceURL.indexOf('#');
        if (pos === -1) {
            return 1;
        } else {
            return parseInt(this.deviceURL.substring(pos + 1));
        }
    }

    get baseUrl() {
        const pos = this.deviceURL.indexOf('#');
        if (pos === -1) {
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
        return model !== null ? model : this.definition.uiClass;
    }

    get serialNumber() {
        return this.uuid;
    }

    get address() {
        //const regex = /(([0-9]{4})[-]){2}([0-9]{4})[/]/;
        const regex = /[//](.)*[/]/;
        return this.deviceURL.replace(regex, '');
    }

    get protocol(): string {
        return this.controllableName.split(':').shift() || '';
    }

    get uniqueName(): string {
        return this.controllableName.split(':').pop() || '';
    }

    get commands(): Array<string> {
        return this.definition.commands.map((command: CommandDefinition) => command.commandName);
    }

    hasCommand(name: string): boolean {
        return this.definition.commands.find((command: CommandDefinition) => command.commandName === name) !== undefined;
    }

    hasState(name: string): boolean {
        return this.states.find((state: State) => state.name === name) !== undefined;
    }

    hasSensor(widget: string): boolean {
        return this.sensors.find((sensor) => sensor.definition.widgetName === widget) !== undefined;
    }

    isMainDevice() {
        return this.componentId === 1;
    }

    isSensorOf(device: Device) {
        switch (this.controllableName) {
            case 'io:AtlanticPassAPCOutsideTemperatureSensor':
                return false;//device.isMainDevice();
            case 'io:AtlanticPassAPCZoneTemperatureSensor':
                return device.definition.uiClass === 'HeatingSystem';
            case 'io:HeatingRelatedElectricalEnergyConsumptionSensor':
                return device.controllableName === 'io:AtlanticPassAPCHeatPumpMainComponent';
            case 'io:DHWRelatedElectricalEnergyConsumptionSensor':
                return device.controllableName === 'io:AtlanticPassAPCDHWComponent';
            default:
                break;
        }
        switch (this.definition.widgetName) {
            case 'TemperatureSensor':
                return device.definition.uiClass === 'HeatingSystem';
            //this.definition.type === 'SENSOR';
            default:
                break;
        }
    }

    addSensor(device: Device) {
        device.parent = this;
        this.sensors.push(device);
    }

    getState(stateName): State | null {
        if (this.states !== null) {
            for (const state of this.states) {
                if (state.name === stateName) {
                    return state;
                }
            }
        }
        return null;
    }

    updateStates(states: State[]) {
        if (this.pendingUpdateTimer !== null) {
            clearTimeout(this.pendingUpdateTimer);
        }
        for (const newState of states) {
            const state = this.getState(newState.name);
            if (state) {
                // Ignore state type 10 and 11 (object and array of object)
                if (state.type !== 10 && state.type !== 11 && state.value !== newState.value) {
                    state.value = newState.value;
                    this.pendingUpdate.set(newState.name, newState);
                }
            } else {
                this.states.push(newState);
                this.pendingUpdate.set(newState.name, newState);
            }
        }
        this.pendingUpdateTimer = setTimeout(() => {
            this.pendingUpdateTimer = null;
            if (this.pendingUpdate.size > 0) {
                this.emit('states', Array.from(this.pendingUpdate.values()));
                this.pendingUpdate = new Map();
            }
        }, 100);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(stateName): any | null {
        if (this.states !== null) {
            for (const state of this.states) {
                if (state.name === stateName) {
                    return state.value;
                }
            }
        }
        return null;
    }

    getNumber(stateName): number {
        const val = this.get(stateName);
        return val ? Number.parseFloat(val) : 0;
    }
}