/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
import { Wizard } from '../../../shared/wizards/wizard'
import { CloudWatchLogsGroupInfo, CloudWatchLogsParameters, LogDataRegistry } from '../registry/logDataRegistry'
import { createQuickPick, DataQuickPickItem, QuickPickPrompter } from '../../../shared/ui/pickerPrompter'
import { getLogger, truncate } from '../../../shared'
import { createInputBox } from '../../../shared/ui/inputPrompter'
import { RegionSubmenu, RegionSubmenuResponse } from '../../../shared/ui/common/regionSubmenu'
import { DefaultCloudWatchLogsClient } from '../../../shared/clients/cloudWatchLogsClient'
import { CloudWatchLogs } from 'aws-sdk'
import { createBackButton, createExitButton, createHelpButton } from '../../../shared/ui/buttons'
import { createURIFromArgs } from '../cloudWatchLogsUtils'

const localize = nls.loadMessageBundle()

export async function tailLogGroup(logData?: { regionName: string; groupName: string }): Promise<void> {
    const wizard = new TailLogGroupWizard(logData)
    const response = await wizard.run()

    console.log('Printing prompter responses...')
    console.log('Selected LogGroup: ' + response?.regionLogGroupSubmenuResponse.data)
    console.log('Selected Region: ' + response?.regionLogGroupSubmenuResponse.region)
    console.log('Selected LogStream Prefix: ' + response?.logStreamPrefix)
    console.log('Selected FilterPattern: ' + response?.filterPattern)

    const uri = createURIFromArgs(
        {
            groupName: response?.regionLogGroupSubmenuResponse.data,
            regionName: response?.regionLogGroupSubmenuResponse.region,
        },
        {}
    )
    await prepareDocument(uri)
    await displayTailingSessionDialogueWindow(
        response?.regionLogGroupSubmenuResponse.data,
        response?.logStreamPrefix,
        response?.filterPattern
    )
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
        this.form.logStreamPrefix.bindPrompter((state) =>
            createLogStreamPrompter(state.regionLogGroupSubmenuResponse?.data)
        )
        this.form.filterPattern.bindPrompter((state) => createFilterPatternPrompter())
    }
}

export function createRegionLogGroupSubmenu(): RegionSubmenu<string> {
    return new RegionSubmenu(
        getLogGroups,
        {
            title: localize('AWS.cwl.tailLogGroup.logGroupPromptTitle', 'Select Log Group to tail'),
            buttons: [createExitButton()],
        },
        { title: localize('AWS.cwl.tailLogGroup.regionPromptTitle', 'Select Region for Log Group') },
        'LogGroups'
    )
}

async function getLogGroups(regionCode: string) {
    const client = new DefaultCloudWatchLogsClient(regionCode)
    const logGroups = await logGroupsToStringArray(client.describeLogGroups())
    const options = logGroups.map<DataQuickPickItem<string>>((logGroupString) => ({
        label: logGroupString,
        data: logGroupString,
    }))
    return options
}

async function logGroupsToStringArray(logGroups: AsyncIterableIterator<CloudWatchLogs.LogGroup>): Promise<string[]> {
    const logGroupsArray = []
    for await (const logGroupObject of logGroups) {
        logGroupObject.logGroupName && logGroupsArray.push(logGroupObject.logGroupName)
    }
    return logGroupsArray
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
        title: `Provide Log Stream prefix for '${truncate(logGroup, 25)}'`,
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

function displayTailingSessionDialogueWindow(logGroup: string, logStreamPrefix: string, filter: string) {
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
            } else {
                console.log('Window closed by other means')
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
