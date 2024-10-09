import * as vscode from 'vscode'
import { CloudWatchLogsClient, StartLiveTailCommand, StartLiveTailCommandOutput } from '@aws-sdk/client-cloudwatch-logs'
import { LogStreamFilterResponse, LogStreamFilterType } from '../liveTailLogStreamSubmenu'
import { CloudWatchLogsSettings } from '../cloudWatchLogsUtils'
import { Settings } from '../../../shared'
import { createLiveTailURIFromArgs } from './liveTailSessionRegistry'

export type LiveTailStatusBarItems = {
    isSampled: vscode.StatusBarItem
    eventRate: vscode.StatusBarItem
    sessionTimer: vscode.StatusBarItem
}

export class LiveTailSession {
    private liveTailClient: LiveTailSessionClient
    private _logGroupName: string
    private logStreamFilter?: LogStreamFilterResponse
    private logEventFilterPattern?: string
    private _maxLines: number
    private _uri: vscode.Uri
    private startTime: number | undefined
    private endTime: number | undefined
    private _statusBarItems: LiveTailStatusBarItems

    static settings = new CloudWatchLogsSettings(Settings.instance)

    public constructor(configuration: LiveTailSessionConfiguration) {
        this._logGroupName = configuration.logGroupName
        this.logStreamFilter = configuration.logStreamFilter
        this.liveTailClient = {
            cwlClient: new CloudWatchLogsClient({ region: configuration.region }),
            abortController: new AbortController(),
        }
        this._maxLines = LiveTailSession.settings.get('liveTailMaxEvents', 10000)
        this._uri = createLiveTailURIFromArgs(configuration)
        this._statusBarItems = this.createStatusBarItems()
    }

    public get maxLines() {
        return this._maxLines
    }

    public get uri() {
        return this._uri
    }

    public get logGroupName() {
        return this._logGroupName
    }

    public get statusBarItems(): LiveTailStatusBarItems {
        return this._statusBarItems
    }

    public startLiveTailSession(): Promise<StartLiveTailCommandOutput> {
        const command = this.buildStartLiveTailCommand()
        this.startTime = Date.now()
        this.endTime = undefined
        return this.liveTailClient.cwlClient.send(command, {
            abortSignal: this.liveTailClient.abortController.signal,
        })
    }

    public stopLiveTailSession() {
        this.endTime = Date.now()
        this.disposeStatusBarItems()
        this.liveTailClient.abortController.abort()
        this.liveTailClient.cwlClient.destroy()
    }

    //Returns duraton of LiveTail session in ms.
    public getLiveTailSessionDuration(): number {
        if (this.startTime === undefined) {
            return 0
        }
        //Case where the LiveTail session is still running
        if (this.endTime === undefined) {
            return Date.now() - this.startTime
        }
        return this.endTime - this.startTime
    }

    private buildStartLiveTailCommand(): StartLiveTailCommand {
        let logStreamNamePrefix = undefined
        let logStreamName = undefined
        if (this.logStreamFilter) {
            if (this.logStreamFilter.type === LogStreamFilterType.PREFIX) {
                logStreamNamePrefix = this.logStreamFilter.filter
                logStreamName = undefined
            } else if (this.logStreamFilter.type === LogStreamFilterType.SPECIFIC) {
                logStreamName = this.logStreamFilter.filter
                logStreamNamePrefix = undefined
            }
        }

        return new StartLiveTailCommand({
            logGroupIdentifiers: [this.logGroupName],
            logStreamNamePrefixes: logStreamNamePrefix ? [logStreamNamePrefix] : undefined,
            logStreamNames: logStreamName ? [logStreamName] : undefined,
            logEventFilterPattern: this.logEventFilterPattern ? this.logEventFilterPattern : undefined,
        })
    }

    private createStatusBarItems(): LiveTailStatusBarItems {
        return {
            sessionTimer: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0),
            eventRate: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1),
            isSampled: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 2),
        }
    }

    private disposeStatusBarItems() {
        this.statusBarItems.eventRate.dispose()
        this.statusBarItems.isSampled.dispose()
        this.statusBarItems.sessionTimer.dispose()
    }
}

export type LiveTailSessionConfiguration = {
    logGroupName: string
    logStreamFilter?: LogStreamFilterResponse
    logEventFilterPattern?: string
    region: string
}

export type LiveTailSessionClient = {
    cwlClient: CloudWatchLogsClient
    abortController: AbortController
}
