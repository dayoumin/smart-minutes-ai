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
