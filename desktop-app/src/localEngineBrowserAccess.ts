// Chrome 145+ gates a public site's requests to 127.0.0.1 behind 'loopback-network'
// (shown as '기기에 있는 앱'); Chrome 142-144 used 'local-network-access'.
const LOOPBACK_PERMISSION_NAMES = ['loopback-network', 'local-network-access'] as const;

type PermissionQuery = Pick<Permissions, 'query'>;

export type LocalEngineBrowserAccessState = PermissionState | 'unsupported';

/**
 * The browser's decision about this site reaching apps on this PC.
 * A failed fetch looks the same whether the engine is stopped or the browser blocked it,
 * so this is the only way to tell the user which of the two to fix.
 */
export const getLocalEngineBrowserAccessState = async (
    permissions: PermissionQuery | undefined = globalThis.navigator?.permissions,
): Promise<LocalEngineBrowserAccessState> => {
    if (!permissions?.query) return 'unsupported';
    for (const name of LOOPBACK_PERMISSION_NAMES) {
        try {
            const status = await permissions.query({ name } as unknown as PermissionDescriptor);
            return status.state;
        } catch {
            // This browser does not know the permission name; try the older one.
        }
    }
    return 'unsupported';
};

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A page served from this PC reaches 127.0.0.1 without asking; only other sites get the prompt. */
export const pageNeedsLoopbackPermission = (
    hostname: string = globalThis.location?.hostname ?? '',
): boolean => Boolean(hostname) && !LOOPBACK_HOSTNAMES.has(hostname) && !hostname.endsWith('.localhost');

/** A background request was held back so the browser's prompt only follows the user's own click. */
export class LocalEnginePermissionPromptDeferredError extends TypeError {
    constructor() {
        super('Local engine requests wait until the user starts the connection.');
        this.name = 'LocalEnginePermissionPromptDeferredError';
    }
}

/**
 * Chrome asks for '기기에 있는 앱' on the first request to this PC. Raised by a background
 * request on page load, that prompt has no context, gets dismissed, and repeated dismissals
 * make Chrome block the site without asking. So until the user decides, only a request the
 * user started may go out.
 */
export const createLocalEnginePermissionGate = ({
    applies,
    accessState,
}: {
    applies: () => boolean;
    accessState: () => Promise<LocalEngineBrowserAccessState>;
}) => {
    // A browser that reports 'prompt' without enforcing it (or allows the site by policy)
    // still answers; holding requests after that would only stall the connection.
    let engineAnswered = false;
    return {
        beforeRequest: async ({ userInitiated }: { userInitiated: boolean }): Promise<void> => {
            if (userInitiated || engineAnswered || !applies()) return;
            const state = await accessState().catch(() => 'unsupported' as const);
            if (state === 'prompt') throw new LocalEnginePermissionPromptDeferredError();
        },
        noteResponse: (): void => { engineAnswered = true; },
    };
};
