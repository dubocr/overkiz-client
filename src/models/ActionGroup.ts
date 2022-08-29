import Action from './Action';

export default interface ActionGroup {
    oid: string;
    label: string;
    actions: Action[];
    metadata: string;
}