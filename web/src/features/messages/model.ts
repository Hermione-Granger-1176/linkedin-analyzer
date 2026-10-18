/* LinkedIn Analyzer: Shapes of the messages analytics data */

/** One cleaned messages.csv row, keyed by column name (FROM, TO, DATE, ...). */
export type MessageRow = Record<string, string>;

/** One cleaned Connections.csv row, keyed by column name (First Name, URL, ...). */
export type ConnectionRow = Record<string, string>;

/** Normalized URLs and names identified as the export owner. */
export interface SelfContext {
    /** Normalized self profile URLs */
    selfUrls: Set<string>;
    /** Normalized self names */
    selfNames: Set<string>;
}

/** A message participant after sanitizing: a display name and normalized URL. */
export interface Participant {
    /** Display name ("Unknown" when only a URL is known) */
    name: string;
    /** Normalized profile URL, or "" when absent */
    url: string;
}

/** Aggregated message totals for one contact. */
export interface MessageContact {
    /** Contact key ("url:..." or "name:...") */
    key: string;
    /** Display name */
    name: string;
    /** Normalized profile URL, or "" */
    url: string;
    /** Messages involving this contact */
    count: number;
    /** Latest message timestamp (ms) */
    lastTimestamp: number;
}

/**
 * Message events stored as columns, one entry per participant per message.
 * contactIds[i] indexes contactKeys; timestamps[i] is the message time.
 */
export interface MessageEvents {
    /** Contact key for each contact ID */
    contactKeys: string[];
    /** Contact ID of each event */
    contactIds: Int32Array<ArrayBuffer>;
    /** Timestamp (ms) of each event */
    timestamps: Float64Array<ArrayBuffer>;
}

/**
 * Outreach-funnel summary: who starts conversations and how often they are answered.
 * A type alias rather than an interface, so it stays assignable to the plain
 * record `Storage.saveOutreach` stores.
 */
export type OutreachSummary = {
    /** Distinct conversations */
    totalConversations: number;
    /** Conversations started by self */
    selfInitiated: number;
    /** Conversations started by someone else */
    othersInitiated: number;
    /** Self-started conversations that got a reply */
    selfInitiatedReplied: number;
    /** selfInitiatedReplied / selfInitiated, or null */
    replyRate: number | null;
    /** Contacts messaged who never replied */
    unansweredContacts: number;
    /** Messages sent by self */
    sent: number;
    /** Messages received from real correspondents */
    received: number;
    /** sent / received, or null */
    sentReceivedRatio: number | null;
};

/** Message analytics state built from cleaned rows. */
export interface MessageState {
    /** Contacts by contact key */
    contacts: Map<string, MessageContact>;
    /** Per-participant event columns */
    events: MessageEvents;
    /** Timestamp (ms) of each counted row */
    rowTimestamps: Float64Array<ArrayBuffer>;
    /** Rows without a date or a participant */
    skippedRows: number;
    /** Normalized names of everyone messaged */
    talkedNameKeys: Set<string>;
    /** Normalized URLs of everyone messaged */
    talkedUrlKeys: Set<string>;
    /** Latest counted message timestamp (ms) */
    latestTimestamp: number;
    /** Outreach summary, when available */
    outreach: OutreachSummary | null;
}

/** One connection, normalized for lookups. */
export interface Connection {
    /** Full name, or the URL when the name is blank */
    name: string;
    /** Normalized full name */
    nameKey: string;
    /** Normalized profile URL, or "" */
    url: string;
    /** Company */
    company: string;
    /** Position */
    position: string;
    /** Connection date (ms), or null */
    connectedOnTimestamp: number | null;
}

/** Connection list plus URL and name indexes (first entry wins). */
export interface ConnectionState {
    /** All connections, in file order */
    list: Connection[];
    /** Connections by normalized URL */
    byUrl: Map<string, Connection>;
    /** Connections by normalized name */
    byName: Map<string, Connection>;
}

/** Per-conversation outreach aggregate. */
export interface ConversationAggregate {
    /** Earliest message timestamp (ms) */
    firstTimestamp: number;
    /** Whether the earliest message was sent by self */
    startedBySelf: boolean;
    /** Whether a real correspondent ever sent a message */
    gotReply: boolean;
}

/** Participation counts for a self-detection candidate key. */
export interface ParticipantStats {
    /** Appearances on either side */
    totalCount: number;
    /** Appearances as sender */
    senderCount: number;
    /** Appearances as recipient */
    recipientCount: number;
    /** Conversations the key appears in */
    conversations: Set<string>;
}

/** Per-role counter in ParticipantStats */
export type RoleCountField = "senderCount" | "recipientCount";
