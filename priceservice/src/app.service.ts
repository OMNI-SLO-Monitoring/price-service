import { HttpService, Injectable } from '@nestjs/common';
import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  Policy,
  SamplingBreaker,
  TaskCancelledError,
  TimeoutStrategy,
  CircuitBreakerPolicy,
} from 'cockatiel';
import { ConfigHandlerService } from './config-handler/config-handler.service';
import { LogMessageFormat, LogType } from 'logging-format';

/**
 * Contains the methods for the circuitBreaker and the methods that send the http requests to the database service
 */
@Injectable()
export class AppService {
  constructor(
    private configHandlerService: ConfigHandlerService,
    private httpService: HttpService,
  ) {
    this.setupBreaker();
  }

  private breaker: CircuitBreakerPolicy;

  /**
    Initializes the CircuitBreaker based on the selected configurations
    called in constructor and in config-handler.controller.ts
  */
  public setupBreaker() {
    if (this.configHandlerService.breakerType == 'consecutive') {
      /*
       * Constructor for the consecutiveBreaker
       * The ConsecutiveBreaker breaks after n requests in a row fail
       * More info at https://github.com/connor4312/cockatiel#consecutivebreaker
       */
      this.breaker = Policy.handleAll().circuitBreaker(
        this.configHandlerService.resetDuration,
        new ConsecutiveBreaker(this.configHandlerService.consecutiveFailures),
      );
    } else {
      /*
       * Constructor for the samplingBreaker
       * The SamplingBreaker breaks after a proportion of requests over a time period fail
       * More infos at https://github.com/connor4312/cockatiel#samplingbreaker
       */
      this.breaker = Policy.handleAll().circuitBreaker(
        this.configHandlerService.resetDuration,
        new SamplingBreaker({
          threshold: this.configHandlerService.threshold,
          duration: this.configHandlerService.monitorDuration,
          minimumRps: this.configHandlerService.minimumRequests,
        }),
      );
    }
  }

  /**
   * Sends data that is put in to the error monitor.
   * Prints success or failure of the http call to the console
   *
   * @param log to be send
   */
  private sendError(log: LogMessageFormat): LogMessageFormat {
    this.httpService.post(this.configHandlerService.monitorUrl, log).subscribe(
      res =>
        console.log(
          `Report sent to monitor at ${this.configHandlerService.monitorUrl}`,
        ),
      err =>
        console.log(
          `Monitor at ${this.configHandlerService.monitorUrl} not available`,
        ),
    );
    return log;
  }

  /**
   * Calls the handleTimeout() function and inserts the returned result into the
   * return value if the underlying get request to the database service was successful.
   * Otherwise, a log of the type LogMessageFormat will be created with the correspondent
   * property values of the error and sent to the error response monitor.
   *
   * @param url request destination
   *
   * @returns JSON with properties type, message and result where type takes the value of "Success" if no
   * error has been experienced, message denotes the successful procedure and result takes on the fetched
   * value of the underlying get request to the database service
   */
  public async handleRequest(url: string): Promise<any> {
    try {
      const data = await this.breaker.execute(() => this.handleTimeout(url));
      return {
        type: 'Success',
        message: 'Request to database was successful',
        result: data,
      };
    } catch (error) {
      let log;

      if (error instanceof BrokenCircuitError) {
        log = {
          type: LogType.CB_OPEN,
          time: Date.now(),
          message: 'CircuitBreaker is open.',
          source: 'Database Service',
          detector: 'Price Service',
          data: {
            openTime: this.configHandlerService.resetDuration,
            failedResponses: this.configHandlerService.consecutiveFailures,
          },
        };
      } else if (error instanceof TaskCancelledError) {
        log = {
          type: LogType.TIMEOUT,
          time: Date.now(),
          message: 'Request was timed out.',
          source: 'Database Service',
          detector: 'Price Service',
          data: {
            timeoutDuration: this.configHandlerService.timeoutDuration,
          },
        };
      } else {
        log = {
          type: LogType.ERROR,
          time: Date.now(),
          message: 'Service is not available.',
          source: 'Database Service',
          detector: 'Price Service',
          data: {
            expected: 'Not an error',
            result: error.message,
          },
        };
      }

      return this.sendError(log);
    }
  }

  /**
   * Calls the function that sends a request to the database via a timeout function and
   * extracts the returned result
   * Will timeout the function call if the configured time is exceeded
   *
   * @param url request destination
   *
   * @returns the result extracted from the function sendToDatabase()
   */
  private async handleTimeout(url: string) {
    let result;
    try {
      const timeout = Policy.timeout(
        this.configHandlerService.timeoutDuration,
        TimeoutStrategy.Aggressive,
      );

      const data = await timeout.execute(async () => {
        result = await this.sendRequest(url);
      });
      return result;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Sends a get request to the specified endpoint of the database service
   * This endpoint will be determined in the router handler functions in
   * the app controller
   *
   * @param url request destination
   *
   * @returns Returns the fetched data of the get request if request was successful
   * and an error otherwise
   */
  private async sendRequest(url: string) {
    try {
      const send = await this.httpService.get(url).toPromise();
      if (send.status == 200) {
        console.log(`Request to ${url} was successful`);
      }
      return send.data;
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
