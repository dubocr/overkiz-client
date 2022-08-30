import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import { logger } from './Client';

let httpClient;

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
        const result = await httpClient.post(this.accessTokenUrl, params, {headers});
        if(!result.data.access_token) {
            throw new Error('Invalid credentials');
        }
        return result.data.access_token;
    }

    public async getJwt(token: string) {
        const headers = {
            'Authorization': `Bearer ${token}`,
        };
        const result = await httpClient.get(this.jwtUrl, {headers});
        console.log(result.data.trim());
        return result.data.trim();
    }
}

export default class RestClient extends EventEmitter {
    private http: AxiosInstance;
    private authRequest?: Promise<unknown>;
    private isLogged = false;
    private badCredentials = false;
    private lockdownDelay = 60;

    constructor(
        private readonly user: string,
        private readonly password: string,
        private readonly endpoint: ApiEndpoint,
        readonly proxy: string | null,
        private readonly gatewayPin: string,
    ) {
        super();

        this.http = axios.create({
            baseURL: this.endpoint.apiUrl,
            withCredentials: true,
        });

        httpClient = axios.create();

        const interceptor = (request) => {
            if(proxy) {
                request.url = proxy
                    + '?endpoint=' + encodeURI(request.baseURL ?? '')
                    + '&path=' + encodeURI(request.url)
                    + '&method=' + request.method?.toUpperCase();
            }
            logger.debug(request.method?.toUpperCase(), request.url);
            return request;
        };

        this.http.interceptors.request.use(interceptor);
        httpClient.interceptors.request.use(interceptor);
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

    public async enableLocalApi() {
        const data = await this.get('config/' + this.gatewayPin + '/local/tokens/generate');
        logger.debug(data);
        const resp = await this.post('config/' + this.gatewayPin + '/local/tokens', {
            'label': 'Homebridge-tahoma local API',
            'token': data.token,
            'scope': 'devmode',
        });
        logger.debug(resp);
        this.http.defaults.headers['Autorization'] = 'Bearer ' + data.token;
        this.http.defaults.baseURL = 'https://gateway-' + this.gatewayPin + ':8443/enduser-mobile-web/1/enduserAPI/';
        logger.debug('Local API enabled');
    }

    public disableLocalApi() {
        delete this.http.defaults.headers['Autorization'];
        this.http.defaults.baseURL = this.endpoint.apiUrl;
        logger.debug('Local API disabled');
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
                if(this.gatewayPin) {
                    this.disableLocalApi();
                }
                this.authRequest = this.endpoint
                    .getLoginParams(this.user, this.password)
                    .then((params) => this.http.post('/login', params))
                    .then(async (response) => {
                        this.isLogged = true;
                        this.lockdownDelay = 60;
                        if (response.headers['set-cookie']) {
                            const cookie = response.headers['set-cookie']?.find((cookie) => cookie.startsWith('JSESSIONID'))?.split(';')[0];
                            if(cookie) {
                                this.http.defaults.headers.common['Cookie'] = cookie;
                            }
                        }
                        if(this.gatewayPin) {
                            await this.enableLocalApi();
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
