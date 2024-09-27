/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { logAndThrowIfUnexpectedExitCode, SamCliProcessInvoker } from './samCliInvokerUtils'
import path from 'path'
import * as os from 'os'
import { getSpawnEnv } from '../../env/resolveEnv'

export const TestEventsOperation = {
    List: 'list',
    Get: 'get',
    Put: 'put',
}
export interface SamCliRemoteTestEventsParameters {
    operation: string
    functionArn?: string
    name?: string
    region?: string
    eventSample?: string
    projectRoot?: vscode.Uri
    stackName?: string
    logicalId?: string
}

export async function runSamCliRemoteTestEvents(
    remoteTestEventsParameters: SamCliRemoteTestEventsParameters,
    invoker: SamCliProcessInvoker
): Promise<string> {
    const args = ['remote', 'test-event', remoteTestEventsParameters.operation]
    if (remoteTestEventsParameters.functionArn) {
        args.push(remoteTestEventsParameters.functionArn)
    } else if (remoteTestEventsParameters.stackName && remoteTestEventsParameters.logicalId) {
        args.push('--stack-name', remoteTestEventsParameters.stackName, remoteTestEventsParameters.logicalId)
    }

    if (remoteTestEventsParameters.region) {
        args.push('--region', remoteTestEventsParameters.region)
    }

    if (remoteTestEventsParameters.name) {
        args.push('--name', remoteTestEventsParameters.name)
    }

    if (remoteTestEventsParameters.operation === TestEventsOperation.Put && remoteTestEventsParameters.eventSample) {
        const tempFileUri = vscode.Uri.file(path.join(os.tmpdir(), 'event-sample.json'))
        await vscode.workspace.fs.writeFile(tempFileUri, Buffer.from(remoteTestEventsParameters.eventSample, 'utf8'))
        args.push('--file', tempFileUri.fsPath)
    }

    const childProcessResult = await invoker.invoke({
        arguments: args,
        spawnOptions: {
            env: await getSpawnEnv(process.env),
            cwd: remoteTestEventsParameters.projectRoot?.fsPath,
        },
    })
    logAndThrowIfUnexpectedExitCode(childProcessResult, 0)

    return childProcessResult.stdout
}
