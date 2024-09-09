/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
import { Wizard } from '../../../shared/wizards/wizard'
import { CloudWatchLogsGroupInfo } from '../registry/logDataRegistry'
import { DataQuickPickItem } from '../../../shared/ui/pickerPrompter'
import { formatDateTimestamp, Settings } from '../../../shared'
import { createInputBox } from '../../../shared/ui/inputPrompter'
import { RegionSubmenu, RegionSubmenuResponse } from '../../../shared/ui/common/regionSubmenu'
import { DefaultCloudWatchLogsClient } from '../../../shared/clients/cloudWatchLogsClient'
import { createBackButton, createExitButton, createHelpButton } from '../../../shared/ui/buttons'
import { createURIFromArgs } from '../cloudWatchLogsUtils'
import { CancellationError } from '../../../shared/utilities/timeoutUtils'
import {
    CloudWatchLogsClient,
    LiveTailSessionLogEvent,
    StartLiveTailCommand,
    StartLiveTailCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs'
import { int } from 'aws-sdk/clients/datapipeline'
import { LogStreamFilterResponse, LogStreamFilterSubmenu, LogStreamFilterType } from '../liveTailLogStreamSubmenu'

const localize = nls.loadMessageBundle()
const abortController = new AbortController()

export async function tailLogGroup(logData?: { regionName: string; groupName: string }): Promise<void> {
    const wizard = new TailLogGroupWizard(logData)
    const response = await wizard.run()
    if (!response) {
        throw new CancellationError('user')
    }

    const logGroupName = response.regionLogGroupSubmenuResponse.data
    const regionName = response.regionLogGroupSubmenuResponse.region
    const logStreamFilter = response.logStreamFilter
    const filterPattern = response.filterPattern
    const maxLines = Number(response.maxLines)

    console.log('Printing prompter responses...')
    console.log('Selected LogGroup: ' + logGroupName)
    console.log('Selected Region: ' + regionName)
    console.log(`LogStream Filter: ${logStreamFilter.type} ${logStreamFilter.filter}`)
    console.log('Selected FilterPattern: ' + filterPattern)
    console.log('Max lines ' + maxLines)

    const uri = createURIFromArgs(
        {
            groupName: logGroupName,
            regionName: regionName,
        },
        {}
    )
    const textDocument = await prepareDocument(uri)

    //TODO: Implement handler to close session when Editor closes
    vscode.window.onDidChangeVisibleTextEditors(async (events) => {
        console.log('events')
        console.log(events)
        console.log('visible test editors')
        console.log(vscode.window.visibleTextEditors)
        console.log('text documents')
        console.log(vscode.workspace.textDocuments)

        //Editor can close, but TextDocument stays open.
        //Just changing active text editor triggers this callback
        //
        // events.forEach((event) => console.log(`callback: ${event === textEditor}`))
    })

    vscode.workspace.onDidCloseTextDocument((e) => {
        console.log(e)
    })

    const cwClient = new CloudWatchLogsClient({ region: regionName })

    const command = buildStartLiveTailCommand(logGroupName, logStreamFilter, filterPattern)
    try {
        const resp = await cwClient.send(command, {
            abortSignal: abortController.signal,
        })
        displayTailingSessionDialogueWindow(logGroupName, logStreamFilter, filterPattern, cwClient)
        await handleLiveTailResponse(resp, textDocument, maxLines)
    } catch (err) {
        console.log(err)
    }
}

export interface TailLogGroupWizardResponse {
    regionLogGroupSubmenuResponse: RegionSubmenuResponse<string>
    logStreamFilter: LogStreamFilterResponse
    filterPattern: string
    maxLines: string
}

export class TailLogGroupWizard extends Wizard<TailLogGroupWizardResponse> {
    public constructor(logGroupInfo?: CloudWatchLogsGroupInfo) {
        super({
            initState: {
                regionLogGroupSubmenuResponse: logGroupInfo
                    ? {
                          data: logGroupInfo.groupName,
                          region: logGroupInfo.regionName,
                      }
                    : undefined,
            },
        })
        // this.form.logGroup.bindPrompter((state) => createLogGroupSubmenu())
        this.form.regionLogGroupSubmenuResponse.bindPrompter(createRegionLogGroupSubmenu)
        this.form.logStreamFilter.bindPrompter((state) => {
            if (!state.regionLogGroupSubmenuResponse?.data) {
                throw Error('LogGroupName is null')
            }
            return new LogStreamFilterSubmenu(
                state.regionLogGroupSubmenuResponse.data,
                state.regionLogGroupSubmenuResponse.region
            )
        })
        this.form.filterPattern.bindPrompter((state) => createFilterPatternPrompter())
        this.form.maxLines.bindPrompter((state) => createMaxLinesPrompter())
    }
}

export function createRegionLogGroupSubmenu(): RegionSubmenu<string> {
    return new RegionSubmenu(
        getLogGroupQuickPickOptions,
        {
            title: localize('AWS.cwl.tailLogGroup.logGroupPromptTitle', 'Select Log Group to tail'),
            buttons: [createExitButton()],
        },
        { title: localize('AWS.cwl.tailLogGroup.regionPromptTitle', 'Select Region for Log Group') },
        'LogGroups'
    )
}

async function getLogGroupQuickPickOptions(regionCode: string): Promise<DataQuickPickItem<string>[]> {
    const client = new DefaultCloudWatchLogsClient(regionCode)
    const logGroups = client.describeLogGroups()

    const logGroupsOptions: DataQuickPickItem<string>[] = []

    for await (const logGroupObject of logGroups) {
        if (!logGroupObject.arn || !logGroupObject.logGroupName) {
            throw Error('LogGroupObject name or arn undefined')
        }

        logGroupsOptions.push({
            label: logGroupObject.logGroupName,
            data: formatLogGroupArn(logGroupObject.arn),
        })
    }

    return logGroupsOptions
}

function formatLogGroupArn(logGroupArn: string): string {
    return logGroupArn.endsWith(':*') ? logGroupArn.substring(0, logGroupArn.length - 2) : logGroupArn
}

export function createFilterPatternPrompter() {
    const helpUri = 'https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html'
    return createInputBox({
        title: 'Provide Log filter pattern',
        placeholder: 'filter pattern (case sensitive; empty matches all)',
        buttons: [createHelpButton(helpUri), createBackButton(), createExitButton()],
    })
}

function createMaxLinesPrompter() {
    return createInputBox({
        title: 'Provide maximum number of lines',
        prompt: 'Enter an integer value between 1,000 and 15,000',
        value: '1000',
        validateInput: validateMaxLinesInput,
    })
}

function validateMaxLinesInput(input: string) {
    const maxLines = Number(input)
    if (isNaN(Number(input)) || !Number.isSafeInteger(maxLines) || maxLines < 1000 || maxLines > 15000) {
        return 'Input must be a positive integer value between 1,000 and 15,000'
    }
    return undefined
}

function displayTailingSessionDialogueWindow(
    logGroup: string,
    logStreamPrefix: LogStreamFilterResponse,
    filter: string,
    cwClient: CloudWatchLogsClient
) {
    let message = `Tailing Log Group: '${logGroup}.'`

    if (logStreamPrefix && logStreamPrefix.type === LogStreamFilterType.SPECIFIC) {
        message += `LogStream: '${logStreamPrefix.filter}.'`
    } else if (logStreamPrefix && logStreamPrefix.type === LogStreamFilterType.PREFIX) {
        message += `LogStream prefx: '${logStreamPrefix.filter}.'`
    }

    if (filter) {
        message += ` Filter pattern: '${filter}'`
    }
    const stopTailing = 'Stop Tailing'
    return vscode.window.showInformationMessage(message, stopTailing).then((item) => {
        try {
            if (item && item === stopTailing) {
                stopLiveTailSession(cwClient)
            } else {
                console.log('Window dismissed')
            }
        } catch (e) {
            console.log('[EXCEPTION]', e)
        }
    })
}

async function prepareDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const textDocument = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(textDocument, { preview: false })
    vscode.languages.setTextDocumentLanguage(textDocument, 'log')
    return textDocument
}

async function handleLiveTailResponse(
    response: StartLiveTailCommandOutput,
    textDocument: vscode.TextDocument,
    maxLines: int
) {
    if (!response.responseStream) {
        throw Error('response is undefined')
    }

    try {
        for await (const event of response.responseStream) {
            if (event.sessionStart !== undefined) {
                console.log(event.sessionStart)
            } else if (event.sessionUpdate !== undefined) {
                const formattedLogEvents = event.sessionUpdate.sessionResults!.map<string>((logEvent) =>
                    formatLogEvent(logEvent)
                )
                //Determine should scroll before adding new lines to doc because large amount of
                //new lines can push bottom of file out of view before scrolling.
                const shouldScroll = shouldScrollTextDocument(textDocument)
                await updateTextDocumentWithNewLogEvents(formattedLogEvents, textDocument, maxLines)
                console.log(`Should scroll: ${shouldScroll}`)
                if (shouldScroll) {
                    scrollTextDocument(textDocument)
                }
            } else {
                console.error('Unknown event type')
            }
        }
    } catch (err) {
        console.warn('Caught on-stream exception: ' + err)
    }
}

async function updateTextDocumentWithNewLogEvents(
    formattedLogEvents: string[],
    textDocument: vscode.TextDocument,
    maxLines: int
) {
    const edit = new vscode.WorkspaceEdit()
    formattedLogEvents.forEach((formattedLogEvent) =>
        edit.insert(textDocument.uri, new vscode.Position(textDocument.lineCount, 0), formattedLogEvent)
    )
    if (textDocument.lineCount + formattedLogEvents.length > maxLines) {
        trimOldestLines(formattedLogEvents.length, textDocument, edit, maxLines)
    }
    await vscode.workspace.applyEdit(edit)
}

//TODO: Trimming lines seems to jitter the screen. Can we keep the lines the customer has in view, fixed in place?
//Scroll up num lines deleted?
function trimOldestLines(
    numNewLines: number,
    textDocument: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    maxLines: int
) {
    const numLinesToTrim = textDocument.lineCount + numNewLines - maxLines
    const startPosition = new vscode.Position(0, 0)
    const endPosition = new vscode.Position(numLinesToTrim, 0)

    const range = new vscode.Range(startPosition, endPosition)
    edit.delete(textDocument.uri, range)
    edit
}

function formatLogEvent(logEvent: LiveTailSessionLogEvent): string {
    if (!logEvent.timestamp || !logEvent.message) {
        return ''
    }
    const timestamp = formatDateTimestamp(true, new Date(logEvent.timestamp))
    let line = timestamp.concat('\t', logEvent.message)
    if (!line.endsWith('\n')) {
        line = line.concat('\n')
    }
    return line
}

function shouldScrollTextDocument(textDocument: vscode.TextDocument): boolean {
    const editor = vscode.window.visibleTextEditors.find((editor) => editor.document === textDocument)
    if (!editor) {
        return false
    }
    const lineCount = textDocument.lineCount
    const listLinePos = new vscode.Position(lineCount - 1, 0)
    const visibleRange = editor?.visibleRanges[0]
    if (visibleRange?.contains(listLinePos)) {
        return true
    }
    return false
}

function scrollTextDocument(textDocument: vscode.TextDocument) {
    const editor = getEditorFromTextDocument(textDocument)
    if (!editor) {
        return
    }
    const topPosition = new vscode.Position(Math.max(editor.document.lineCount - 2, 0), 0)
    const bottomPosition = new vscode.Position(Math.max(editor.document.lineCount - 2, 0), 0)

    editor.revealRange(new vscode.Range(topPosition, bottomPosition), vscode.TextEditorRevealType.Default)
}

function getEditorFromTextDocument(textDocument: vscode.TextDocument): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((editor) => editor.document === textDocument)
}

function stopLiveTailSession(cwClient: CloudWatchLogsClient) {
    console.log('Stoping live tail session...')
    abortController.abort()
    cwClient.destroy()
}

function buildStartLiveTailCommand(
    logGroup: string,
    logStreamFilter: LogStreamFilterResponse,
    filter: string
): StartLiveTailCommand {
    let logStreamNamePrefix = undefined
    let logStreamName = undefined

    if (logStreamFilter.type === LogStreamFilterType.PREFIX) {
        logStreamNamePrefix = logStreamFilter.filter
        logStreamName = undefined
    } else if (logStreamFilter.type === LogStreamFilterType.SPECIFIC) {
        logStreamName = logStreamFilter.filter
        logStreamNamePrefix = undefined
    }

    return new StartLiveTailCommand({
        logGroupIdentifiers: [logGroup],
        logStreamNamePrefixes: logStreamNamePrefix ? [logStreamNamePrefix] : undefined,
        logStreamNames: logStreamName ? [logStreamName] : undefined,
        logEventFilterPattern: filter ? filter : undefined,
    })
}
