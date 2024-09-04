/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
import { Wizard } from '../../../shared/wizards/wizard'
import { CloudWatchLogsGroupInfo } from '../registry/logDataRegistry'
import { createQuickPick, DataQuickPickItem } from '../../../shared/ui/pickerPrompter'
import { formatDateTimestamp, truncate } from '../../../shared'
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
import { CloudWatchLogs } from 'aws-sdk'
import { pageableToCollection } from '../../../shared/utilities/collectionUtils'
import { stat } from 'fs'

const localize = nls.loadMessageBundle()

export async function tailLogGroup(logData?: { regionName: string; groupName: string }): Promise<void> {
    const wizard = new TailLogGroupWizard(logData)
    const response = await wizard.run()
    if (!response) {
        throw new CancellationError('user')
    }

    const logGroupName = response.regionLogGroupSubmenuResponse.data
    const regionName = response.regionLogGroupSubmenuResponse.region
    const logStreamPrefix = response.logStreamPrefix
    const filterPattern = response.filterPattern
    const maxLines = Number(response.maxLines)

    console.log('Printing prompter responses...')
    console.log('Selected LogGroup: ' + logGroupName)
    console.log('Selected Region: ' + regionName)
    console.log('Selected LogStream Prefix: ' + logStreamPrefix)
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
    const textEditor = getEditorFromTextDocument(textDocument)

    //TODO: Can't tell if this is working.
    // If editor closes, the getEditorFromTextDocument during scroll throws.
    vscode.window.onDidChangeVisibleTextEditors(async (events) => {
        events.forEach((event) => console.log(`callback: ${event === textEditor}`))
    })

    const cwClient = new CloudWatchLogsClient({ region: regionName })

    const command = new StartLiveTailCommand({
        logGroupIdentifiers: [logGroupName],
        logStreamNamePrefixes: [logStreamPrefix],
        logEventFilterPattern: filterPattern,
    })

    try {
        const resp = await cwClient.send(command)
        displayTailingSessionDialogueWindow(logGroupName, logStreamPrefix, filterPattern, cwClient)
        await handleLiveTailResponse(resp, textDocument, maxLines)
    } catch (err) {
        console.log(err)
    }
}

export interface TailLogGroupWizardResponse {
    regionLogGroupSubmenuResponse: RegionSubmenuResponse<string>
    logStreamPrefix: string
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
        this.form.logStreamPrefix.bindPrompter((state) => {
            if (!state.regionLogGroupSubmenuResponse?.data) {
                throw Error('LogGroupName is null')
            }
            return createLogStreamPrompter(
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

export function createLogStreamPrompter(logGroup: string, region: string) {
    // const logStreamNames = ['a-log-stream', 'ab-log-stream', 'c-log-stream']
    // const logStreamQuickPickItems = logStreamNames.map<DataQuickPickItem<string>>((logStreamsString) => ({
    //     label: logStreamsString,
    //     data: logStreamsString,
    // }))
    const client = new DefaultCloudWatchLogsClient(region)
    const request: CloudWatchLogs.DescribeLogStreamsRequest = {
        logGroupIdentifier: logGroup,
        orderBy: 'LastEventTime',
        descending: true,
    }
    const requester = (request: CloudWatchLogs.DescribeLogStreamsRequest) => client.describeLogStreams(request)
    const collection = pageableToCollection(requester, request, 'nextToken', 'logStreams')
    const streamToItem = (logStream: CloudWatchLogs.LogStream) => ({
        label: logStream.logStreamName,
        data: logStream.logStreamName,
    })
    const items = collection.flatten().map(streamToItem)
    const defaultItem: DataQuickPickItem<string>[] = [
        {
            label: 'Tail all Log Streams (default)',
            data: '*',
            description: 'Tail events from all Log Streams in the selected Log Group',
        },
        {
            label: 'Log Streams',
            kind: vscode.QuickPickItemKind.Separator,
            data: undefined,
        },
    ]

    const qp = createQuickPick(defaultItem, {
        title: `(Optional) Provide Log Stream prefix for '${truncate(logGroup, 25)}'`,
        placeholder: '(Optional) Select a specific Log Stream or provide Log Stream prefix',
        buttons: [createBackButton(), createExitButton()],
        filterBoxInputSettings: {
            label: 'Select LogStream prefix',
            transform: (resp) => resp,
        },
    })
    qp.loadItems(items)
    return qp
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
    logStreamPrefix: string,
    filter: string,
    cwClient: CloudWatchLogsClient
) {
    let message = `Tailing Log Group: '${logGroup}.'`

    if (logStreamPrefix && logStreamPrefix !== '*') {
        message += ` LogStream prefix: '${logStreamPrefix}.'`
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
                reportSizeOfTextDocument(textDocument)
            } else {
                console.error('Unknown event type')
            }
        }
    } catch (err) {
        // On-stream exceptions are captured here
        console.error(err)
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
    const editor = getEditorFromTextDocument(textDocument)
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
    const topPosition = new vscode.Position(Math.max(editor.document.lineCount - 2, 0), 0)
    const bottomPosition = new vscode.Position(Math.max(editor.document.lineCount - 2, 0), 0)

    editor.revealRange(new vscode.Range(topPosition, bottomPosition), vscode.TextEditorRevealType.Default)
}

function getEditorFromTextDocument(textDocument: vscode.TextDocument): vscode.TextEditor {
    const editor = vscode.window.visibleTextEditors.find((editor) => editor.document === textDocument)
    if (!editor) {
        throw Error('No editor for textDocument found')
    }
    return editor
}

function stopLiveTailSession(cwClient: CloudWatchLogsClient) {
    console.log('Stoping live tail session...')
    cwClient.destroy()
}

function reportSizeOfTextDocument(textDocument: vscode.TextDocument) {
    // const fs = vscode.workspace.fs.stat(textDocument.uri).then((stats) => console.log(`Size of file: ${stats.size}`))
}
