import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import { logger, interceptor } from './Client';
import https from 'https';

export default class ApiClient extends EventEmitter {
    public readonly client: AxiosInstance = axios.create();
    private connectPromise?: Promise<void>;
    protected isAuthenticated?: boolean;

    private user?: string;
    private password?: string;

    constructor() {
        super();
        this.client.interceptors.request.use(interceptor);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected async authenticate(user: string, password: string): Promise<void> {
        return;
    }
    
    private request(options, reconnect: boolean) {
        return this.connect()
            .then(() => this.client(options))
            .then((response) => response.data)
            .catch((error) => {
                if (error.response) {
                    //logger.debug(error.response.data);
                    let msg = 'Error ' + error.response.status;
                    const json = error.response.data;
                    if (json && json.error) {
                        msg += ' ' + json.error;
                    }
                    if (json && json.errorCode) {
                        msg += ' (' + json.errorCode + ')';
                    }
                    if (error.response.status === 401) {
                        // Session expired
                        this.connectPromise = undefined;
                        if(this.isAuthenticated) {
                            this.isAuthenticated = false;
                            logger.debug('Session expired:', msg);
                            this.emit('disconnect');
                            if(reconnect) {
                                return this.request(options, false);
                            }
                        }
                    }
                    //logger.debug(msg);
                    throw msg;
                } else if (error.message) {
                    logger.debug('Error:', error.message);
                    throw error.message;
                } else {
                    logger.debug('Error:', error);
                    throw error;
                }
            });
    }

    public setCredentials(user: string, password: string) {
        this.user = user;
        this.password = password;
    }

    public async restoreSession(authenticated: boolean) {
        this.isAuthenticated = authenticated;
        if(this.isAuthenticated) {
            this.connectPromise = Promise.resolve();
            this.emit('connect');
        }
    }

    public connect() {
        if(this.connectPromise === undefined) {
            if(!this.user || !this.password) {
                throw new Error('Invalid credentials provided');
            }
            this.connectPromise = this.authenticate(this.user, this.password);
            this.connectPromise.then(() => {
                if(!this.isAuthenticated) {
                    this.isAuthenticated = true;
                    this.emit('connect');
                }
            });
            
        }
        return this.connectPromise;
    }

    public get(url: string, reconnect = true) {
        return this.request({
            method: 'get',
            url: url,
        }, reconnect);
    }

    public post(url: string, data?: Record<string, unknown> | Array<string>, reconnect = true) {
        return this.request({
            method: 'post',
            url: url,
            data: data,
        }, reconnect);
    }

    public put(url: string, data?: Record<string, unknown>, reconnect = true) {
        return this.request({
            method: 'put',
            url: url,
            data: data,
        }, reconnect);
    }

    public delete(url: string, reconnect = true) {
        return this.request({
            method: 'delete',
            url: url,
        }, reconnect);
    }
}


export class LocalApiClient extends ApiClient {
    static IPV4_REGEXP = new RegExp(/^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/gm);
    static PIN_REGEXP = new RegExp(/^[0-9]{4}-[0-9]{4}-[0-9]{4}$/gm);

    protected async authenticate(user: string, password: string): Promise<void> {
        let domain;
        if(user.match(LocalApiClient.IPV4_REGEXP)) {
            domain = user;
        } else if(user.match(LocalApiClient.PIN_REGEXP)) {
            domain = 'gateway-' + user + '.local';
            if(typeof process === 'object') {
                // mDNS lookup on nodeJS only
                try {
                    domain = await this.findGatewayIP(user);
                } catch(error) {
                    logger.warn('No gateway found on your network:', error);
                    logger.warn('Please check gateway pin number and make sur developer mode is activated.');
                    logger.warn('For more information: https://developer.somfy.com/developer-mode');
                }
            }
        } else {
            throw new Error('Invalid username. Please provide gateway PIN (XXXX-XXXX-XXXX) or gateway IP');
        }
        this.client.defaults.baseURL = 'https://' + domain + ':8443/enduser-mobile-web/1/enduserAPI';
        this.client.defaults.headers.common['Authorization'] = 'Bearer ' + password;
        this.client.defaults.httpsAgent = new https.Agent({  
            rejectUnauthorized: false,
        });
        // Test API endpoint to validate credentials
        const response = await this.client.get('/apiVersion');
        logger.debug(response.data);
    }

    async findGatewayIP(gatewayPin: string) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mdns = require('bonjour');
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject('Search timeout after 10 seconds');
            }, 10 * 1000);
            mdns().find(
                { type: 'kizboxdev' },
                (service) => {
                    logger.debug('Gateway service found:', service.name);
                    if(service.txt.gateway_pin === gatewayPin) {
                        clearTimeout(timeout);
                        for(const ip of service.addresses) {
                            if(ip.match(LocalApiClient.IPV4_REGEXP)) {
                                logger.debug('Gateway IPv4 is ' + ip);
                                resolve(ip);
                            }
                        }
                    } else {
                        logger.debug('Gateway PIN mismatch:', service.txt?.gateway_pin);
                    }
                },
            );
            logger.debug('Looking for local gateway with pin ' + gatewayPin);
        });
    }
}

export class CloudApiClient extends ApiClient {
    private isLockedDown = false;
    private lockdownDelay = 60;

    constructor(private readonly host: string) {
        super();
        this.client.defaults.baseURL = 'https://' + host + '/enduser-mobile-web/enduserAPI';
        if(typeof window !== 'undefined' && this.isAuthenticated === undefined) {
            // Try connection with cookie on browser
            this.client.get('/authenticated')
                .then((result) => this.restoreSession(result.data.authenticated))
                .catch(() => this.isAuthenticated = false);
        } else {
            this.isAuthenticated = false;
        }
    }

    protected async authenticate(user: string, password: string): Promise<void> {
        if (this.isLockedDown) {
            throw 'API client locked. Please check your credentials then restart.\n'
            + 'If your credentials are valid, please wait some hours to be unbanned';
        }
        try {
            const params = await this.getLoginParams(user, password);
            const response = await this.client.post('/login', params);
            const cookie = response.headers['set-cookie']?.find((cookie) => cookie.startsWith('JSESSIONID'))?.split(';')[0];
            if(cookie) {
                this.client.defaults.headers.common['Cookie'] = cookie;
            }
            this.lockdownDelay = 60;
        } catch(error: any) {
            //error.response.data.errorCode === 'AUTHENTICATION_ERROR'
            if(error.response.status >= 400 && error.response.status < 500) {
                this.isLockedDown = true;
                logger.warn(
                    'API client will be locked for ' + this.getLockdownString()
                    + ' because of bad credentials or temporary service outage.'
                    + ' You can restart plugin to force login retry'
                    + ' (not recommanded except if you think your credentials are wrong).',
                );
                setTimeout(() => {
                    this.isLockedDown = false;
                    this.lockdownDelay *= 2;
                }, this.lockdownDelay * 1000);
            }
            throw error;
        }
    }

    async getLoginParams(user: string, password: string): Promise<URLSearchParams> {
        const params = new URLSearchParams();
        params.append('userId', user);
        params.append('userPassword', password);
        return params;
    }

    getLockdownString() {
        if(this.lockdownDelay > 3600) {
            return Math.round(this.lockdownDelay / 3600) + ' hours';
        } else if(this.lockdownDelay > 60) {
            return Math.round(this.lockdownDelay / 60) + ' minutes';
        } else {
            return this.lockdownDelay + ' seconds';
        }
    }
}

export class CloudJWTApiClient extends CloudApiClient {
    constructor(
        host: string,
        private readonly accessTokenUrl: string,
        private readonly jwtUrl: string,
        private readonly accessTokenBasic: string,
    ) {
        super(host);
    }

    async getLoginParams(user: string, password: string): Promise<URLSearchParams> {
        const accesToken = await this.getAccessToken(user, password);
        const jwt = await this.getJwt(accesToken);

        const params = new URLSearchParams();
        params.append('jwt', jwt);
        return params;
    }

    private async getAccessToken(user: string, password: string) {
        const headers = {
            'Authorization': `Basic ${this.accessTokenBasic}`,
        };
        const params = new URLSearchParams();
        params.append('grant_type', 'password');
        params.append('username', user);
        params.append('password', password);
        const result = await this.client.post(this.accessTokenUrl, params, {headers});
        if(!result.data.access_token) {
            throw new Error('Invalid credentials');
        }
        return result.data.access_token;
    }

    public async getJwt(token: string) {
        const headers = {
            'Authorization': `Bearer ${token}`,
        };
        const result = await this.client.get(this.jwtUrl, {headers});
        return result.data.trim();
    }
}