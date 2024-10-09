import * as vscode from 'vscode'
import { CLOUDWATCH_LOGS_LT_SCHEME } from '../../../shared/constants'
import { LiveTailSession, LiveTailSessionConfiguration } from './liveTailSession'
import { LogStreamFilterType } from '../wizard/liveTailLogStreamSubmenu'

export class LiveTailSessionRegistry {
    static #instance: LiveTailSessionRegistry

    public static get instance() {
        return (this.#instance ??= new this())
    }

    public constructor(private readonly registry: Map<string, LiveTailSession> = new Map()) {}

    public registerLiveTailSession(session: LiveTailSession) {
        if (this.doesRegistryContainLiveTailSession(session.uri)) {
            throw new Error(`There is already a LiveTail session registered with uri: ${session.uri}`)
        }
        this.registry.set(this.uriToKey(session.uri), session)
    }

    public getLiveTailSessionFromUri(uri: vscode.Uri): LiveTailSession {
        const session = this.registry.get(this.uriToKey(uri))
        if (!session) {
            throw new Error(`No LiveTail session registered for uri: ${uri} found.`)
        }
        return session
    }

    public removeLiveTailSessionFromRegistry(uri: vscode.Uri) {
        this.registry.delete(this.uriToKey(uri))
    }

    public doesRegistryContainLiveTailSession(uri: vscode.Uri): boolean {
        return this.registry.has(this.uriToKey(uri))
    }

    private uriToKey(uri: vscode.Uri): string {
        return uri.toString()
    }
}

export function createLiveTailURIFromArgs(sessionData: LiveTailSessionConfiguration): vscode.Uri {
    let uriStr = `${CLOUDWATCH_LOGS_LT_SCHEME}:${sessionData.region}:${sessionData.logGroupName}`

    if (sessionData.logStreamFilter) {
        if (sessionData.logStreamFilter.type != LogStreamFilterType.ALL) {
            uriStr += `:${sessionData.logStreamFilter.type}:${sessionData.logStreamFilter.filter}`
        } else {
            uriStr += `:${sessionData.logStreamFilter.type}`
        }
    }
    uriStr += sessionData.logEventFilterPattern ? `:${sessionData.logEventFilterPattern}` : ''

    return vscode.Uri.parse(uriStr)
}
