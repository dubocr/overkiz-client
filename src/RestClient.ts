import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import { URLSearchParams } from 'url';
import { logger } from './Client';

interface AuthProvider {
    getLoginParams(user: string, password: string): Promise<URLSearchParams>;
}

export class ApiEndpoint implements AuthProvider {
    constructor(public apiUrl: string) {
    }

    getApiUrl(): string {
        return this.apiUrl;
    }

    async getLoginParams(user: string, password: string): Promise<URLSearchParams> {
        const params = new URLSearchParams();
        params.append('userId', user);
        params.append('userPassword', password);
        return params;
    }
}

export class JWTEndpoint extends ApiEndpoint {
    private http: AxiosInstance;
    
    constructor(apiUrl: string, private accessTokenUrl: string, private jwtUrl: string, private accessTokenBasic: string) {
        super(apiUrl);
        this.http = axios.create();
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
        const result = await this.http.post(this.accessTokenUrl, params, {headers});
        return result.data.access_token;
    }

    public async getJwt(token: string) {
        const headers = {
            'Authorization': `Bearer ${token}`,
        };
        const result = await this.http.get(this.jwtUrl, {headers});
        return result.data.trim();
    }
}

export default class RestClient extends EventEmitter {
    private http: AxiosInstance;
    private authRequest?: Promise<unknown>;
    private isLogged = false;
    private badCredentials = false;
    private lockdownDelay = 60;

    constructor(private readonly user: string, private readonly password: string, private readonly endpoint: ApiEndpoint) {
        super();
        this.http = axios.create({
            baseURL: this.endpoint.apiUrl,
            withCredentials: true,
        });

        this.http.interceptors.request.use(request => {
            logger.debug(request.method?.toUpperCase(), request.url);
            return request;
        });
    }

    public get(url: string) {
        return this.request({
            method: 'get',
            url: url,
        });
    }

    public post(url: string, data?: Record<string, unknown>) {
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
        if (this.badCredentials) {
            throw 'API client locked. Please check your credentials then restart.\n'
            + 'If your credentials are valid, please wait some hours to be unbanned';
        }
        let request;
        if (this.isLogged) {
            request = this.http(options);
        } else {
            if (this.authRequest === undefined) {
                this.authRequest = this.endpoint.getLoginParams(this.user, this.password)
                    .then((params) => this.http.post('/login', params))
                    .then((response) => {
                        this.isLogged = true;
                        this.lockdownDelay = 60;
                        if (response.headers['set-cookie']) {
                            this.http.defaults.headers.common['Cookie'] = response.headers['set-cookie'];
                        }
                        this.emit('connect');
                    }).finally(() => {
                        this.authRequest = undefined;
                    });
            }
            request = this.authRequest.then(() => this.http(options));
        }

        return request
            .then((response) => response.data)
            .catch((error) => {
                if (error.response) {
                    if (error.response.status === 401) { // Reauthenticate
                        if (this.isLogged) {
                            this.isLogged = false;
                            this.emit('disconnect');
                            return this.request(options);
                        } else {
                            if (error.response.data.errorCode === 'AUTHENTICATION_ERROR') {
                                this.badCredentials = true;
                                logger.warn(
                                    'API client will be locked for '
                                    + this.lockdownDelay
                                    + ' hours because of bad credentials or temporary service outage.'
                                    + ' You can restart plugin to force login retry.',
                                );
                                setTimeout(() => {
                                    this.badCredentials = false;
                                    this.lockdownDelay *= 2;
                                }, this.lockdownDelay * 1000);
                            }
                            throw error.response.data.error;
                        }
                    } else {
                        //logger.debug(error.response.data);
                        let msg = 'Error ' + error.response.status;
                        const json = error.response.data;
                        if (json && json.error) {
                            msg += ' ' + json.error;
                        }
                        if (json && json.errorCode) {
                            msg += ' (' + json.errorCode + ')';
                        }
                        logger.debug(msg);
                        throw msg;
                    }
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
