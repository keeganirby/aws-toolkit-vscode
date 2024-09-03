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
import { CloudWatchLogs } from 'aws-sdk'
import { createBackButton, createExitButton, createHelpButton } from '../../../shared/ui/buttons'
import { createURIFromArgs } from '../cloudWatchLogsUtils'
import { CancellationError } from '../../../shared/utilities/timeoutUtils'
import {
    CloudWatchLogsClient,
    LiveTailSessionLogEvent,
    StartLiveTailCommand,
    StartLiveTailCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs'
import { log } from 'console'

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

    console.log('Printing prompter responses...')
    console.log('Selected LogGroup: ' + logGroupName)
    console.log('Selected Region: ' + regionName)
    console.log('Selected LogStream Prefix: ' + logStreamPrefix)
    console.log('Selected FilterPattern: ' + filterPattern)

    const uri = createURIFromArgs(
        {
            groupName: logGroupName,
            regionName: regionName,
        },
        {}
    )
    const textDocument = await prepareDocument(uri)
    console.log(regionName)
    const cwClient = new CloudWatchLogsClient({ region: regionName })
    const command = new StartLiveTailCommand({
        logGroupIdentifiers: [logGroupName],
    })
    console.log('SLT Request: ')
    console.log(command)
    try {
        const resp = await cwClient.send(command)
        console.log('SLT Response')
        console.log(resp)
        displayTailingSessionDialogueWindow(logGroupName, logStreamPrefix, filterPattern, cwClient)
        await handleLiveTailResponse(resp, textDocument)
    } catch (err) {
        console.log(err)
    }
}

export interface TailLogGroupWizardResponse {
    regionLogGroupSubmenuResponse: RegionSubmenuResponse<string>
    logStreamPrefix: string
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
        // this.form.logGroup.bindPrompter((state) => createLogGroupSubmenu())
        this.form.regionLogGroupSubmenuResponse.bindPrompter(createRegionLogGroupSubmenu)
        this.form.logStreamPrefix.bindPrompter((state) => {
            if (!state.regionLogGroupSubmenuResponse?.data) {
                throw Error('LogGroupName is null')
            }
            return createLogStreamPrompter(state.regionLogGroupSubmenuResponse.data)
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

export function createLogStreamPrompter(logGroup: string) {
    const logStreamNames = ['a-log-stream', 'ab-log-stream', 'c-log-stream']
    const logStreamQuickPickItems = logStreamNames.map<DataQuickPickItem<string>>((logStreamsString) => ({
        label: logStreamsString,
        data: logStreamsString,
    }))

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

    const quickPickItems: DataQuickPickItem<string>[] = defaultItem.concat(logStreamQuickPickItems)
    return createQuickPick(quickPickItems, {
        title: `(Optional) Provide Log Stream prefix for '${truncate(logGroup, 25)}'`,
        canPickMany: true,
        placeholder: '(Optional) Select a specific Log Stream or provide Log Stream prefix',
        buttons: [createBackButton(), createExitButton()],
        filterBoxInputSettings: {
            label: 'Select LogStream prefix',
            transform: (resp) => resp,
        },
    })
}

export function createFilterPatternPrompter() {
    const helpUri = 'https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html'
    return createInputBox({
        title: 'Provide Log filter pattern',
        placeholder: 'filter pattern (case sensitive; empty matches all)',
        buttons: [createHelpButton(helpUri), createBackButton(), createExitButton()],
    })
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
                console.log('Stop tailing button pressed')
                cwClient.destroy()
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

async function handleLiveTailResponse(response: StartLiveTailCommandOutput, textDocument: vscode.TextDocument) {
    if (!response.responseStream) {
        throw Error('response is undefined')
    }

    try {
        for await (const event of response.responseStream) {
            if (event.sessionStart !== undefined) {
                console.log(event.sessionStart)
            } else if (event.sessionUpdate !== undefined) {
                const edit = new vscode.WorkspaceEdit()
                for (const logEvent of event.sessionUpdate.sessionResults!) {
                    await addLiveTailLogEventToTextDocument(logEvent, edit, textDocument)
                }
                await vscode.workspace.applyEdit(edit)
                const shouldScroll = shouldScrollTextDocument(textDocument)
                console.log(`Should scroll: ${shouldScroll}`)
                if (shouldScroll) {
                    scrollTextDocument(textDocument)
                }
            } else {
                console.error('Unknown event type')
            }
        }
    } catch (err) {
        // On-stream exceptions are captured here
        console.error(err)
    }
}

async function addLiveTailLogEventToTextDocument(
    logEvent: LiveTailSessionLogEvent,
    edit: vscode.WorkspaceEdit,
    textDocument: vscode.TextDocument
) {
    edit.insert(textDocument.uri, new vscode.Position(textDocument.lineCount, 0), `${formatLogEvent(logEvent)}`)
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

    editor.revealRange(new vscode.Range(topPosition, bottomPosition), vscode.TextEditorRevealType.InCenter)
}

function getEditorFromTextDocument(textDocument: vscode.TextDocument): vscode.TextEditor {
    const editor = vscode.window.visibleTextEditors.find((editor) => editor.document === textDocument)
    if (!editor) {
        throw Error('No editor for textDocument found')
    }
    return editor
}
