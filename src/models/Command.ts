export default class Command {
    type: number = 1;
    name: string = '';
    parameters: any[] = [];

    constructor(name, parameters?: any) {
        this.name = name;
        if (parameters === undefined) {
            parameters = [];
        } else if (!Array.isArray(parameters)) {
            parameters = [parameters];
        }
        this.parameters = parameters;
    }
}