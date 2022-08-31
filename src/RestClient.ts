import axios, { AxiosInstance, AxiosPromise } from 'axios';
import { EventEmitter } from 'events';
import { logger } from './Client';
import https from 'https';

interface AuthProvider {
    authenticate(user: string, password: string): Promise<AxiosInstance>;
}

export class LocalApiEndpoint implements AuthProvider {

    async authenticate(user: string, password: string): Promise<AxiosInstance> {
        const ipRegExp = new RegExp(/^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/gm);
        const domain = user.match(ipRegExp) ? user : 'gateway-' + user;
        return axios.create({
            baseURL: 'https://' + domain + ':8443/enduser-mobile-web/1/enduserAPI/',
            
            headers: {
                'Authorization': 'Bearer ' + password,
            },
            httpsAgent: new https.Agent({  
                rejectUnauthorized: false,
            }),
        });
    }
}

export class ApiEndpoint implements AuthProvider {
    private badCredentials = false;
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
        if (this.badCredentials) {
            throw 'API client locked. Please check your credentials then restart.\n'
            + 'If your credentials are valid, please wait some hours to be unbanned';
        }
        try {
            const params = await this.getLoginParams(user, password);
            const response = await axios.post(this.apiUrl + '/login', params);
            if (response.headers['set-cookie']) {
                const cookie = response.headers['set-cookie']?.find((cookie) => cookie.startsWith('JSESSIONID'))?.split(';')[0];
                if(cookie) {
                    this.lockdownDelay = 60;
                    return axios.create({
                        baseURL: this.apiUrl,
                        withCredentials: true,
                        headers: {
                            'Cookie': cookie,
                        },
                    });
                }
            }
        } catch(error: any) {
            //error.response.data.errorCode === 'AUTHENTICATION_ERROR'
            if(error.response.status >= 400 && error.response.status < 500) {
                this.badCredentials = true;
                logger.warn(
                    'API client will be locked for '
                    + this.lockdownDelay
                    + ' seconds because of bad credentials or temporary service outage.'
                    + ' You can restart plugin to force login retry.',
                );
                setTimeout(() => {
                    this.badCredentials = false;
                    this.lockdownDelay *= 2;
                }, this.lockdownDelay * 1000);
            }
            throw error;
        }
        throw new Error('Enable to authenticate');
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
