/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
import { Wizard } from '../../../shared/wizards/wizard'
import { CloudWatchLogsGroupInfo } from '../registry/logDataRegistry'
import { DataQuickPickItem } from '../../../shared/ui/pickerPrompter'
import { formatDateTimestamp, globals } from '../../../shared'
import { createInputBox } from '../../../shared/ui/inputPrompter'
import { RegionSubmenu, RegionSubmenuResponse } from '../../../shared/ui/common/regionSubmenu'
import { DefaultCloudWatchLogsClient } from '../../../shared/clients/cloudWatchLogsClient'
import { createBackButton, createExitButton, createHelpButton } from '../../../shared/ui/buttons'
import { CloudWatchLogsSettings, createURIFromArgs } from '../cloudWatchLogsUtils'
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
const settings = new CloudWatchLogsSettings()

export async function tailLogGroup(logData?: { regionName: string; groupName: string }): Promise<void> {
    const abortController = new AbortController()
    const wizard = new TailLogGroupWizard(logData)
    const response = await wizard.run()
    if (!response) {
        throw new CancellationError('user')
    }

    const logGroupName = response.regionLogGroupSubmenuResponse.data
    const regionName = response.regionLogGroupSubmenuResponse.region
    const logStreamFilter = response.logStreamFilter
    const filterPattern = response.filterPattern
    const maxLines = settings.get('liveTailMaxEvents', 10000)

    const uri = createURIFromArgs(
        {
            groupName: logGroupName,
            regionName: regionName,
        },
        {}
    )
    const textDocument = await prepareDocument(uri)
    const cwClient = new CloudWatchLogsClient({ region: regionName })

    registerDocumentCloseCallback(cwClient, uri, abortController)
    registerTimerStatusBarItem()

    startLiveTail(logGroupName, logStreamFilter, filterPattern, maxLines, cwClient, textDocument, abortController)
}

export interface TailLogGroupWizardResponse {
    regionLogGroupSubmenuResponse: RegionSubmenuResponse<string>
    logStreamFilter: LogStreamFilterResponse
    filterPattern: string
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
        title: 'Provide log event filter pattern',
        placeholder: 'filter pattern (case sensitive; empty matches all)',
        buttons: [createHelpButton(helpUri), createBackButton(), createExitButton()],
    })
}

function displayTailingSessionDialogueWindow(
    logGroup: string,
    logStreamPrefix: LogStreamFilterResponse,
    filter: string,
    cwClient: CloudWatchLogsClient,
    abortController: AbortController
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
                stopLiveTailSession(cwClient, abortController)
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
                console.log('Got new log events.')
                const formattedLogEvents = event.sessionUpdate.sessionResults!.map<string>((logEvent) =>
                    formatLogEvent(logEvent)
                )
                //Determine should scroll before adding new lines to doc because large amount of
                //new lines can push bottom of file out of view before scrolling.
                const shouldScroll = shouldScrollTextDocument(textDocument)
                await updateTextDocumentWithNewLogEvents(formattedLogEvents, textDocument, maxLines)
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

function stopLiveTailSession(cwClient: CloudWatchLogsClient, abortController: AbortController) {
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

function createLiveTailSessionTimerStatusBar(): vscode.StatusBarItem {
    const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    myStatusBarItem.text = '00:00:00'
    myStatusBarItem.show
    return myStatusBarItem
}

//TODO: This appears to stop the tailing session correctly when the tab closes, but does not dispose of the underlying TextDocument. I think Log data (and the doucment) remains in memory.
function registerDocumentCloseCallback(
    cwClient: CloudWatchLogsClient,
    uri: vscode.Uri,
    abortController: AbortController
) {
    vscode.window.tabGroups.onDidChangeTabs((tabEvent) => {
        if (tabEvent.closed.length > 0) {
            tabEvent.closed.forEach((tab) => {
                if (tab.input instanceof vscode.TabInputText) {
                    if (tab.input.uri.path === uri.path) {
                        stopLiveTailSession(cwClient, abortController)
                    }
                }
            })
        }
    })
}

function registerTimerStatusBarItem() {
    const startTime = Date.now()
    const statusBarTimer = createLiveTailSessionTimerStatusBar()
    globals.clock.setInterval(() => {
        const elapsedTime = Date.now() - startTime
        statusBarTimer.text = `${Math.floor(elapsedTime / 1000)}`
        statusBarTimer.show()
    }, 500)
}

async function startLiveTail(
    logGroupName: string,
    logStreamFilter: LogStreamFilterResponse,
    filterPattern: string,
    maxLines: number,
    cwlClient: CloudWatchLogsClient,
    textDocument: vscode.TextDocument,
    abortController: AbortController
) {
    const command = buildStartLiveTailCommand(logGroupName, logStreamFilter, filterPattern)
    try {
        const resp = await cwlClient.send(command, {
            abortSignal: abortController.signal,
        })
        displayTailingSessionDialogueWindow(logGroupName, logStreamFilter, filterPattern, cwlClient, abortController)
        await handleLiveTailResponse(resp, textDocument, maxLines)
    } catch (err) {
        console.log(err)
    }
}
