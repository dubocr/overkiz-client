/* eslint-disable no-console */
import dotenv from 'dotenv';
import { Client } from './index';
import { default as Device, State } from './models/Device';
import Gateway from './models/Gateway';

dotenv.config();
process.on('unhandledRejection', (error) => console.error('unhandledRejection: ', error));
process.on('uncaughtException', (error) => console.error('uncaughtException: ', error));

async function main() {
    const client = new Client(console, {
        service: process.env.SERVICE,
        user: process.env.USERNAME,
        password: process.env.PASSWORD,
        proxy: process.env.PROXY,
        pollingPeriod: 10,
        refreshPeriod: 60,
        debug: true,
    });
    //client.setCredentials(process.env.USERNAME, process.env.PASSWORD);

    const setup = await client.getSetup();
    /*console.log(`${setup.gateways.length} gateways`);
    setup.gateways.forEach((gateway: Gateway) => {
        console.log(`- ${gateway.gatewayId}`);

    });*/

    console.log(`${setup.devices.length} devices`);
    setup.devices.forEach((device: Device) => {
        console.log(`${device.parent ? ' ' : ''}\x1b[34m${device.label}\x1b[0m (${device.definition.uiClass} > ${device.definition.widgetName})`);
        device.sensors.forEach((sensor: Device) => console.log(`\t - \x1b[34m${sensor.label}\x1b[0m (${sensor.definition.widgetName})`));
        device.on('states', (states) => {
            console.log(device.label + ' states updated');
            states.forEach((state: State) => console.log('\t - ' + state.name + '=' + state.value));
        });
    });

    process.openStdin().addListener('data', async (d) => {
        const data = d.toString().trim();
        switch (data) {
            case 'a':
                //await client.refreshStates();
                await client.refreshAllStates();
                break;
            case 's':
                await client.getSetup();
                break;
            case 't':
                if (process.env.GATEWAY) {
                    const token = await client.createLocalApiToken(process.env.GATEWAY, 'Token TEST');
                    console.log(token);
                }
                break;
            case 'g':
                if (process.env.GATEWAY) {
                    const tokens = await client.getLocalApiTokens(process.env.GATEWAY);
                    console.log(tokens);
                }
                break;
            case '': break;
            default:
                console.log('Input: ' + data);
                await client.refreshDeviceStates(data);
                break;
        }
    });
}
main().catch((error) => console.error('Main error: ', error));