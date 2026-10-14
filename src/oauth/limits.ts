// Caps on client metadata. Registration (DCR) is anonymous and its rows are
// kept, and a published document (CIMD) comes from anyone: what one client
// can make this server store or show is bounded the same way for both.
export const MAX_CLIENT_NAME = 100;
export const MAX_LIST_ENTRIES = 10;
export const MAX_FIELD_LENGTH = 2048;
