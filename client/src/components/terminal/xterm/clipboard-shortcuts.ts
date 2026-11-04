// Let the browser handle Windows clipboard shortcuts while retaining Ctrl+C
// as an interrupt when there is no terminal selection.
export function useTerminalKey(event: KeyboardEvent, platform: string, hasSelection: boolean): boolean {
    if (
        event.type !== 'keydown' ||
        !/^win/i.test(platform) ||
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey
    )
        return true;

    const key = event.key.toLowerCase();
    return key !== 'v' && !(key === 'c' && hasSelection);
}
