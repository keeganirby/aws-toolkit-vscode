/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Prompter, PromptResult } from '../../shared/ui/prompter'
import { DefaultCloudWatchLogsClient } from '../../shared/clients/cloudWatchLogsClient'
import { createCommonButtons } from '../../shared/ui/buttons'
import { createInputBox, InputBoxPrompter } from '../../shared/ui/inputPrompter'
import { createQuickPick, DataQuickPickItem, QuickPickPrompter } from '../../shared/ui/pickerPrompter'
import { pageableToCollection } from '../../shared/utilities/collectionUtils'
import { CloudWatchLogs } from 'aws-sdk'
import { isValidResponse, StepEstimator } from '../../shared/wizards/wizard'

export enum LogStreamFilterType {
    MENU = 'menu',
    PREFIX = 'prefix',
    SPECIFIC = 'specific',
    ALL = 'all',
}

export interface LogStreamFilterResponse {
    readonly filter?: string
    readonly type: LogStreamFilterType
}

export class LogStreamFilterSubmenu extends Prompter<LogStreamFilterResponse> {
    private logStreamPrefixRegEx = new RegExp('[^:*]*')
    private currentState: LogStreamFilterType = LogStreamFilterType.MENU
    private steps?: [current: number, total: number]
    private region: string
    private logGroup: string
    public defaultPrompter: QuickPickPrompter<LogStreamFilterType> = this.createMenuPrompter()

    public constructor(logGroup: string, region: string) {
        super()
        this.region = region
        this.logGroup = logGroup
    }

    public createMenuPrompter() {
        const prompter = createQuickPick(this.menuOptions, {
            title: 'Select LogStream filter type',
            buttons: createCommonButtons(),
        })
        return prompter
    }

    private get menuOptions(): DataQuickPickItem<LogStreamFilterType>[] {
        const options: DataQuickPickItem<LogStreamFilterType>[] = []
        options.push({
            label: 'None',
            description: 'Tail log events from all LogStreams in the selected LogGroup',
            data: LogStreamFilterType.ALL,
        })
        options.push({
            label: 'Specific',
            description: 'Select a specific LogStream to tail log events from',
            data: LogStreamFilterType.SPECIFIC,
        })
        options.push({
            label: 'Prefix',
            description:
                'Provide a custom prefix. Only log events in LogStreams that start with the prefix will be included',
            data: LogStreamFilterType.PREFIX,
        })
        return options
    }

    public createLogStreamPrefixBox(): InputBoxPrompter {
        return createInputBox({
            title: 'Enter custom LogStream prefix',
            placeholder: 'LogStream prefix',
            validateInput: (input) => this.validateLogStreamPrefix(input),
            buttons: createCommonButtons(),
        })
    }

    public validateLogStreamPrefix(input: string) {
        if (input.length > 512) {
            return 'LogStream prefix cannot be longer than 512 characters'
        }

        if (!this.logStreamPrefixRegEx.test(input)) {
            return `LogStream prefix must match pattern: ${this.logStreamPrefixRegEx.source}`
        }
    }

    public createLogStreamSelector(): QuickPickPrompter<string> {
        const client = new DefaultCloudWatchLogsClient(this.region)
        const request: CloudWatchLogs.DescribeLogStreamsRequest = {
            logGroupIdentifier: this.logGroup,
            orderBy: 'LastEventTime',
            descending: true,
        }
        const requester = (request: CloudWatchLogs.DescribeLogStreamsRequest) => client.describeLogStreams(request)
        const collection = pageableToCollection(requester, request, 'nextToken', 'logStreams')
        const isValidLogStream = (obj?: CloudWatchLogs.LogStream): obj is CloudWatchLogs.LogStream => {
            return !!obj && typeof obj.logStreamName === 'string'
        }
        const streamToItem = (logStream: CloudWatchLogs.LogStream): DataQuickPickItem<string> => ({
            label: logStream.logStreamName!,
            data: logStream.logStreamName!,
        })
        const items = collection.flatten().filter(isValidLogStream).map(streamToItem)

        return createQuickPick(items, {
            title: 'Select LogStream to tail',
            buttons: createCommonButtons(),
        })
    }

    private switchState(newState: LogStreamFilterType) {
        this.currentState = newState
    }

    protected async promptUser(): Promise<PromptResult<LogStreamFilterResponse>> {
        while (true) {
            switch (this.currentState) {
                case LogStreamFilterType.MENU: {
                    const prompter = this.createMenuPrompter()
                    this.steps && prompter.setSteps(this.steps[0], this.steps[1])

                    const resp = await prompter.prompt()
                    if (resp === LogStreamFilterType.PREFIX) {
                        this.switchState(LogStreamFilterType.PREFIX)
                    } else if (resp === LogStreamFilterType.SPECIFIC) {
                        this.switchState(LogStreamFilterType.SPECIFIC)
                    } else if (resp === LogStreamFilterType.ALL) {
                        return { filter: undefined, type: resp }
                    }
                    break
                }
                case LogStreamFilterType.PREFIX: {
                    const resp = await this.createLogStreamPrefixBox().prompt()
                    if (isValidResponse(resp)) {
                        return { filter: resp, type: LogStreamFilterType.PREFIX }
                    }
                    this.switchState(LogStreamFilterType.MENU)
                    break
                }
                case LogStreamFilterType.SPECIFIC: {
                    const resp = await this.createLogStreamSelector().prompt()
                    if (isValidResponse(resp)) {
                        return { filter: resp, type: LogStreamFilterType.SPECIFIC }
                    }
                    this.switchState(LogStreamFilterType.MENU)
                    break
                }
            }
        }
    }

    public setSteps(current: number, total: number): void {
        this.steps = [current, total]
    }

    // Unused
    public get recentItem(): any {
        return
    }
    public set recentItem(response: any) {}
    public setStepEstimator(estimator: StepEstimator<LogStreamFilterResponse>): void {}
}
