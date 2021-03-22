import { EventEmitter } from 'events';
import Command from './Command';

export default class Action extends EventEmitter {
    public commands: Command[] = [];

    constructor(public readonly deviceURL: string, commands : Array<Command>) {
        super();
        this.commands.push(...commands);
    }

    addCommands(commands: Array<Command>) {
        this.commands.forEach(command => {
            const existing = this.commands.find((cmd) => cmd.name === command.name);
            if(existing) {
                existing.parameters = command.parameters;
            } else {
                this.commands.push(command);
            }
        });   
    }

    toJSON() {
        return {
            deviceURL: this.deviceURL,
            commands: this.commands,
        };
    }
}