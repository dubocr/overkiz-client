export default interface LocalApiToken {
    label: string;
    gatewayId: string;
    gatewayCreationTime: number;
    expirationTime: number;
    uuid: string;
    scope: string;
}