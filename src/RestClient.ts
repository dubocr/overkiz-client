import axios, { AxiosInstance, AxiosPromise } from 'axios';
import { EventEmitter } from 'events';
import { logger } from './Client';
import https from 'https';
import mdns from 'bonjour';

interface AuthProvider {
    authenticate(user: string, password: string): Promise<AxiosInstance>;
}

export class LocalApiEndpoint implements AuthProvider {
    static IPV4_REGEXP = new RegExp(/^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/gm);
    static PIN_REGEXP = new RegExp(/^[0-9]{4}-[0-9]{4}-[0-9]{4}$/gm);
    
    async authenticate(user: string, password: string): Promise<AxiosInstance> {
        let domain;
        if(user.match(LocalApiEndpoint.IPV4_REGEXP)) {
            domain = user;
        } else if(user.match(LocalApiEndpoint.PIN_REGEXP)) {
            domain = await this.findGatewayIP(user).catch(() => 'gateway-' + user + '.local');
        } else {
            throw new Error('Invalid username. Please provide gateway PIN (XXXX-XXXX-XXXX) or gateway IP');
        }
        const client = axios.create({
            baseURL: 'https://' + domain + ':8443/enduser-mobile-web/1/enduserAPI',
            
            headers: {
                'Authorization': 'Bearer ' + password,
            },
            httpsAgent: new https.Agent({  
                rejectUnauthorized: false,
            }),
        });
        // Test API endpoint to validate credentials
        const response = await client.get('/apiVersion');
        logger.debug(response.data);
        return client;
    }

    async findGatewayIP(gatewayPin: string) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.warn('No gateway found on your network. Please check gateway pin number and make sur you activated developer mode.');
                logger.warn('For more information please browse https://developer.somfy.com/developer-mode');
                reject('Search gateway timeout after 10 seconds');
            }, 10 * 1000);
            mdns().find(
                { type: 'kizboxdev' },
                (service) => {
                    logger.debug('Gateway service found:', service.name);
                    if(service.txt.gateway_pin === gatewayPin) {
                        clearTimeout(timeout);
                        for(const ip of service.addresses) {
                            if(ip.match(LocalApiEndpoint.IPV4_REGEXP)) {
                                logger.debug('Gateway IPv4 is ' + ip);
                                resolve(ip);
                            }
                        }
                    } else {
                        logger.debug('Gateway PIN mismatch:', service.txt?.gateway_pin);
                    }
                }
            );
            logger.debug('Looking for local gateway with pin ' + gatewayPin + '...');
        });
    }
}

export class ApiEndpoint implements AuthProvider {
    private isLockedDown = false;
    private lockdownDelay = 60;

    constructor(public apiUrl: string) {
    }

    async getLoginParams(user: string, password: string): Promise<URLSearchParams> {
        const params = new URLSearchParams();
        params.append('userId', user);
        params.append('userPassword', password);
        return params;
    }

    async authenticate(user: string, password: string): Promise<AxiosInstance> {
        if (this.isLockedDown) {
            throw 'API client locked. Please check your credentials then restart.\n'
            + 'If your credentials are valid, please wait some hours to be unbanned';
        }
        try {
            const params = await this.getLoginParams(user, password);
            const response = await axios.post(this.apiUrl + '/login', params);
            const cookie = response.headers['set-cookie']?.find((cookie) => cookie.startsWith('JSESSIONID'))?.split(';')[0];
            this.lockdownDelay = 60;
            return axios.create({
                baseURL: this.apiUrl,
                withCredentials: true,
                headers: cookie ? { 'Cookie': cookie } : undefined,
            });
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

export class JWTApiEndpoint extends ApiEndpoint {
    constructor(apiUrl: string, public accessTokenUrl: string, public jwtUrl: string, private accessTokenBasic: string) {
        super(apiUrl);
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
        const result = await axios.post(this.accessTokenUrl, params, {headers});
        if(!result.data.access_token) {
            throw new Error('Invalid credentials');
        }
        return result.data.access_token;
    }

    public async getJwt(token: string) {
        const headers = {
            'Authorization': `Bearer ${token}`,
        };
        const result = await axios.get(this.jwtUrl, {headers});
        logger.debug('JWT Token: ' + result.data.trim());
        return result.data.trim();
    }
}

export default class RestClient extends EventEmitter {
    private httpClient: AxiosInstance | null = null;
    private authRequest?: Promise<AxiosInstance>;

    constructor(
        private readonly user: string,
        private readonly password: string,
        private readonly endpoint: ApiEndpoint,
        private readonly proxy: string | null,
    ) {
        super();
        axios.interceptors.request.use(this.onRequest.bind(this));
    }

    private onRequest(request) {
        if(this.proxy) {
            request.url = this.proxy
                + '?endpoint=' + encodeURI(request.baseURL ?? '')
                + '&path=' + encodeURI(request.url)
                + '&method=' + request.method?.toUpperCase();
        }
        logger.debug(request.method?.toUpperCase(), request.url);
        return request;
    }

    public get(url: string) {
        return this.request({
            method: 'get',
            url: url,
        });
    }

    public post(url: string, data?: Record<string, unknown> | Array<string>) {
        return this.request({
            method: 'post',
            url: url,
            data: data,
        });
    }

    public put(url: string, data?: Record<string, unknown>) {
        return this.request({
            method: 'put',
            url: url,
            data: data,
        });
    }

    public delete(url: string) {
        return this.request({
            method: 'delete',
            url: url,
        });
    }

    private request(options) {
        let request: AxiosPromise<any>;
        if (this.httpClient) {
            request = this.httpClient(options);
        } else {
            if (this.authRequest === undefined) {
                this.authRequest = this.endpoint
                    .authenticate(this.user, this.password)
                    .then((client: AxiosInstance) => {
                        client.interceptors.request.use(this.onRequest.bind(this));
                        this.httpClient = client;
                        this.emit('connect');
                        return client;
                    }).finally(() => {
                        this.authRequest = undefined;
                    });
            }
            request = this.authRequest.then((client: AxiosInstance) => client(options));
        }

        return request
            .then((response) => response.data)
            .catch((error) => {
                if (error.response) {
                    if (error.response.status === 401 && this.httpClient !== null) {
                        // Need reauthentication
                        this.httpClient = null;
                        this.emit('disconnect');
                        return this.request(options);
                    }
                    //logger.debug(error.response.data);
                    let msg = 'Error ' + error.response.status;
                    const json = error.response.data;
                    if (json && json.error) {
                        msg += ' ' + json.error;
                    }
                    if (json && json.errorCode) {
                        msg += ' (' + json.errorCode + ')';
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
}
