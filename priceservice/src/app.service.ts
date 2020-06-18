import { HttpService, Injectable } from '@nestjs/common';
import { BrokenCircuitError, ConsecutiveBreaker, Policy, SamplingBreaker, TaskCancelledError, TimeoutStrategy } from "cockatiel";
import { ConfigHandlerService } from './config-handler/config-handler.service';
import { LogMessageFormat, LogType } from "logging-format";
import { TIMEOUT } from 'dns';


@Injectable()
export class AppService {

  
  constructor(private configHandlerService : ConfigHandlerService,
              private httpService : HttpService) {}

  private consecutiveBreaker = Policy.handleAll().circuitBreaker(
    this.configHandlerService.resetDuration, new ConsecutiveBreaker(this.configHandlerService.consecutiveFailures));
    
  private samplingBreaker = Policy.handleAll().circuitBreaker(this.configHandlerService.resetDuration,
    new SamplingBreaker({threshold :this.configHandlerService.threshold, duration : this.configHandlerService.monitorDuration,
    minimumRps : this.configHandlerService.minimumRequests}));  

  private timeout = Policy.timeout(this.configHandlerService.timeoutDuration, TimeoutStrategy.Aggressive);

  

  /**
   * Method that updates the breaker and timeout components
   * 
   * Cant be called from config-handler-service so there is no import circle appService --> configHandlerService --> appService.
   * Has to be checked via the configWasUpdated boolean.
   */
  public updateConfig() {
    
    this.consecutiveBreaker = Policy.handleAll().circuitBreaker(
    this.configHandlerService.resetDuration, new ConsecutiveBreaker(this.configHandlerService.consecutiveFailures));

    this.samplingBreaker = Policy.handleAll().circuitBreaker(this.configHandlerService.resetDuration,
    new SamplingBreaker({threshold :this.configHandlerService.threshold, duration : this.configHandlerService.monitorDuration,
    minimumRps : this.configHandlerService.minimumRequests}));

    this.timeout = Policy.timeout(this.configHandlerService.timeoutDuration, TimeoutStrategy.Aggressive);
  }
    
  /**
   * Sends data that is put in to the error monitor.
   * Prints success or failure of the http call to the console
   * @param data 
   */
  private sendError(type : LogType, message : string, source : string, target : string) {
    let logMsg: LogMessageFormat = {
      type: type,
      time: Date.now(),
      source: source,
      target: target,
      message: message
    }
    this.httpService.post(this.configHandlerService.monitorUrl, logMsg).subscribe(
      res => console.log(`Report sent to monitor at ${this.configHandlerService.monitorUrl}`),
      err => console.log(`Monitor at ${this.configHandlerService.monitorUrl} not available`),
    );
    return logMsg;
  }
  /**
   * 
   */
  public async handleRequest() {
    let returnString = JSON.parse('{"type" : "Success", "message" : "Request to database was successful" }');
    if (this.configHandlerService.configWasUpdated === true) {
      this.updateConfig();
      this.configHandlerService.configWasUpdated = false;
    }    
    try {
      if (this.configHandlerService.breakerType == 'consecutive') {
        const data = await this.consecutiveBreaker.execute(() => this.handleTimeout());
        return returnString
      } else {
        const data = await this.samplingBreaker.execute(() => this.handleTimeout());
        return returnString
      } 
    } catch (error) {
        if (error instanceof BrokenCircuitError) {
          return this.sendError(LogType.CB_OPEN, 'CircuitBreaker is open.', 'priceservice', 'databaseservice')
        } else if (error instanceof TaskCancelledError) {
          return this.sendError(LogType.TIMEOUT,'Request was timed out.',  'priceservice', 'databaseservice')
        } else {
          return this.sendError(LogType.ERROR,'Service is not available.',  'priceservice', 'databaseservice')
        }
    }
  }
  /**
   * 
   */
  private async handleTimeout() {
    try {
        console.log(this.configHandlerService.timeoutDuration);
        const data = await this.timeout.execute(() => this.sendToDatabase());
    } catch (error) {
      return Promise.reject(error)
        }
  }
  /**
   * 
   */       
  private async sendToDatabase() {
    try {
      const send = await this.httpService.get(this.configHandlerService.databaseUrl).toPromise();
      if (send.status == 200) {
        console.log('Request to database was successful')
      }
    } catch (error) {
      return Promise.reject(error)
    }
  }
}

