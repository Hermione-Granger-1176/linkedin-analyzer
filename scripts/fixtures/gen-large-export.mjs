/**
 * Generate a realistic synthetic LinkedIn export of a requested size.
 *
 * Writes messages.csv, Connections.csv, Shares.csv, and Comments.csv to a
 * directory outside the repository (by default under the system temp
 * directory), so browser and memory benchmarks can run without the owner's
 * private export. Column layouts match the fixtures under tests/fixtures/ and
 * web/e2e/fixtures/.
 *
 * The data is shaped like a real export, because unrealistic data hides real
 * costs and bugs:
 *   - One self account sends outgoing rows and receives incoming rows, always
 *     with the same profile URL.
 *   - A few thousand contacts, each with one stable profile URL, including pairs
 *     of different people who share a name.
 *   - Conversation IDs are tied to the participants, not random per row.
 *   - Message bodies carry commas, quotes, line breaks, emoji, and non-Latin
 *     scripts, so the CSV parser and the UTF-8 decoder do real work.
 *   - Dates spread across several years.
 *
 * The PRNG is seeded from the size, so a given size always produces the same
 * files.
 *
 * Usage (prefer the Makefile):
 *   make gen-large-export size_mb=100
 *   make gen-large-export size_mb=30 dir=/tmp/export-30mb
 */
import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    realpathSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const MB = 1024 * 1024;
// Flush to disk in chunks so a 128 MB export never builds one large string.
const FLUSH_BYTES = 4 * MB;

// Share of the requested bytes each file gets, roughly matching a heavy user's
// export, where messages dominate.
const FILE_SHARES = {
    "messages.csv": 0.8,
    "Connections.csv": 0.08,
    "Shares.csv": 0.07,
    "Comments.csv": 0.05,
};

const SELF = { name: "Avery Quinn", url: "https://www.linkedin.com/in/avery-quinn-self" };
const CONTACT_COUNT = 3000;
// Every SAME_NAME_EVERY-th contact reuses the previous contact's name with a
// different profile URL: two different people who share a name.
const SAME_NAME_EVERY = 50;
const FIRST_YEAR = 2019;
const YEAR_SPAN = 7;

const FIRST_NAMES = (
    "Ada Bob Cara Dev Elif Farah Goran Hana Ivan Jia Kofi Lena Mateo Nia Omar Priya " +
    "Quentin Rosa Sven Tariq Uma Viktor Wen Ximena Yusuf Zoe José Zoë Søren Łukasz"
).split(" ");
const LAST_NAMES = (
    "Smith Okafor Nakamura García Müller Kowalski Haddad Ivanova Chen Patel " +
    "Andersson O'Brien Rossi Nguyen Silva Dubois Yılmaz Kim Mensah Novák"
).split(" ");
const COMPANIES = [
    "Acme",
    "Innotech",
    "Northwind",
    "Globex, Inc.",
    "Initech",
    "Umbrella Labs",
    '"Quoted" Co',
    "Stark Industries",
    "Wayne Enterprises",
    "Contoso",
];
const POSITIONS = [
    "Engineer",
    "Product Manager",
    "Designer",
    "Recruiter",
    "Data Scientist",
    "Founder & CEO",
    "Sales, EMEA",
    "Staff Engineer",
    'Head of "Growth"',
    "Analyst",
];
const MESSAGE_PARTS = [
    "Hi, thanks for connecting!",
    "Great to meet you at the conference, let's catch up soon.",
    'Sounds good, "let\'s" do Tuesday.',
    "Here is the link I mentioned: https://example.com/post?id=42&ref=li",
    "line one\nline two\nline three",
    "Congrats on the new role 🎉🚀",
    "Merci beaucoup, à bientôt !",
    "ありがとうございます。来週お話ししましょう。",
    "Спасибо, давайте созвонимся в четверг.",
    "شكرا لك، أراك قريبا",
    "धन्यवाद, जल्द मिलते हैं",
    "感谢分享，非常有帮助。",
    "Quick question, do you have 5 minutes?",
    "Re: the proposal, I think we should go with option B, it is cheaper.",
    "👍",
];
const POST_PARTS = [
    "Excited to share that our team shipped a new feature this week!",
    "Three lessons from a year of building in public:\n1. Ship early\n2. Listen\n3. Repeat",
    'Hiring: we are looking for engineers, designers, and "curious" people.',
    "Grateful for this community 🙏",
    "Nouvelle étape, nouvelle aventure.",
    "新しいプロジェクトを始めました。",
];

/**
 * Deterministic 32-bit PRNG (mulberry32), matching gen-parity-corpus.mjs.
 * @param {number} seed - Initial seed.
 * @returns {() => number} Function returning floats in [0, 1).
 */
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Quote one CSV field when it needs quoting.
 * @param {string} value - Raw field.
 * @returns {string}
 */
function csvField(value) {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Join fields into one CSV line ending in a newline.
 * @param {string[]} fields - Raw fields.
 * @returns {string}
 */
function csvLine(fields) {
    return `${fields.map(csvField).join(",")}\n`;
}

const pad = (value) => String(value).padStart(2, "0");

/**
 * Build the contact list, including same-name pairs with different URLs.
 * @param {() => number} random - Seeded PRNG.
 * @returns {{ name: string, first: string, last: string, url: string }[]}
 */
function buildContacts(random) {
    const pick = (list) => list[Math.floor(random() * list.length)];
    const contacts = [];
    for (let index = 0; index < CONTACT_COUNT; index += 1) {
        const previous = contacts[index - 1];
        const sameName = previous && index % SAME_NAME_EVERY === 0;
        const first = sameName ? previous.first : pick(FIRST_NAMES);
        const last = sameName ? previous.last : pick(LAST_NAMES);
        const slug = `${first}-${last}`.toLowerCase().replace(/[^a-z0-9-]/g, "x");
        contacts.push({
            name: `${first} ${last}`,
            first,
            last,
            url: `https://www.linkedin.com/in/${slug}-${index.toString(36)}`,
        });
    }
    return contacts;
}

/**
 * Write lines from a generator to a file until it reaches a byte target.
 * @param {string} path - Output file.
 * @param {string} header - Lines written before the rows.
 * @param {number} targetBytes - Stop once at least this many bytes are written.
 * @param {() => string} nextRow - Returns the next CSV line.
 * @returns {{ bytes: number, rows: number }}
 */
function writeUntil(path, header, targetBytes, nextRow) {
    // Opening a link would write through it to wherever it points.
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`refusing to overwrite a symbolic link: ${path}`);
    }
    const fd = openSync(path, "w");
    try {
        let bytes = Buffer.byteLength(header);
        let rows = 0;
        let pending = [header];
        let pendingBytes = bytes;
        while (bytes < targetBytes || rows === 0) {
            const line = nextRow();
            const size = Buffer.byteLength(line);
            pending.push(line);
            pendingBytes += size;
            bytes += size;
            rows += 1;
            if (pendingBytes >= FLUSH_BYTES) {
                writeSync(fd, pending.join(""));
                pending = [];
                pendingBytes = 0;
            }
        }
        writeSync(fd, pending.join(""));
        return { bytes, rows };
    } finally {
        closeSync(fd);
    }
}

/**
 * Resolve symlinks in the nearest existing ancestor, so a link that points
 * into the repository cannot pass the location check.
 * @param {string} path - Absolute path that may not exist yet.
 * @returns {string} The path with its existing part made canonical.
 */
function canonical(path) {
    let head = path;
    const tail = [];
    while (!existsSync(head) && dirname(head) !== head) {
        tail.unshift(basename(head));
        head = dirname(head);
    }
    return join(realpathSync(head), ...tail);
}

/**
 * @param {string} path - Canonical absolute path.
 * @returns {boolean} True when the path lies outside the repository.
 */
function isOutsideRepo(path) {
    const fromRepo = relative(realpathSync(REPO), path);
    // A folder inside the repository may itself start with "..", such as "..cache".
    return fromRepo === ".." || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo);
}

/**
 * Generate a full synthetic export.
 * @param {{ sizeMb: number, dir: string }} options - Total size in MiB and output directory.
 * @returns {Record<string, { bytes: number, rows: number }>} Bytes and rows per file.
 */
export function generateLargeExport({ sizeMb, dir }) {
    if (!Number.isFinite(sizeMb) || sizeMb <= 0) {
        throw new Error("size_mb must be a positive number");
    }
    const outDir = resolve(dir);
    if (!isOutsideRepo(canonical(outDir))) {
        throw new Error(`refusing to write inside the repository: ${outDir}`);
    }
    mkdirSync(outDir, { recursive: true });

    const random = mulberry32(Math.round(sizeMb * 1000));
    const pick = (list) => list[Math.floor(random() * list.length)];
    const contacts = buildContacts(random);
    // A skewed pick, so a few contacts get most of the messages, as in real life.
    const pickContact = () => contacts[Math.floor(random() ** 2.5 * contacts.length)];
    const randomInstant = () =>
        new Date(Date.UTC(FIRST_YEAR, 0, 1) + random() * YEAR_SPAN * 365 * 86400000);
    const randomDate = () => {
        const date = randomInstant();
        return (
            `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
            `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
        );
    };
    const body = (parts) => {
        const count = 1 + Math.floor(random() * 3);
        return Array.from({ length: count }, () => pick(parts)).join(" ");
    };
    const target = (file) => Math.round(sizeMb * MB * FILE_SHARES[file]);
    /** @type {Record<string, { bytes: number, rows: number }>} */
    const results = {};

    results["messages.csv"] = writeUntil(
        join(outDir, "messages.csv"),
        csvLine([
            "CONVERSATION ID",
            "FROM",
            "TO",
            "DATE",
            "CONTENT",
            "FOLDER",
            "SENDER PROFILE URL",
            "RECIPIENT PROFILE URLS",
        ]),
        target("messages.csv"),
        () => {
            const contact = pickContact();
            const outgoing = random() < 0.5;
            const [from, to] = outgoing ? [SELF, contact] : [contact, SELF];
            return csvLine([
                `2-${contact.url.slice(-12)}`,
                from.name,
                to.name,
                `${randomDate()} UTC`,
                body(MESSAGE_PARTS),
                "INBOX",
                from.url,
                to.url,
            ]);
        },
    );

    let connectionIndex = 0;
    results["Connections.csv"] = writeUntil(
        join(outDir, "Connections.csv"),
        'Notes:\n"When exporting your connections, you may notice that some of the email addresses are missing."\n\n' +
            csvLine([
                "First Name",
                "Last Name",
                "URL",
                "Email Address",
                "Company",
                "Position",
                "Connected On",
            ]),
        target("Connections.csv"),
        () => {
            const contact = contacts[connectionIndex % contacts.length];
            connectionIndex += 1;
            const date = randomInstant();
            const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
            return csvLine([
                contact.first,
                contact.last,
                contact.url,
                random() < 0.2 ? `${contact.first.toLowerCase()}@example.com` : "",
                pick(COMPANIES),
                pick(POSITIONS),
                `${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()}`,
            ]);
        },
    );

    let shareIndex = 0;
    results["Shares.csv"] = writeUntil(
        join(outDir, "Shares.csv"),
        csvLine(["Date", "ShareLink", "ShareCommentary", "SharedUrl", "MediaUrl", "Visibility"]),
        target("Shares.csv"),
        () => {
            shareIndex += 1;
            return csvLine([
                `${randomDate()} UTC`,
                `https://www.linkedin.com/feed/update/urn:li:share:${shareIndex}`,
                body(POST_PARTS),
                random() < 0.3 ? `https://example.com/article/${shareIndex}` : "",
                "",
                random() < 0.9 ? "MEMBER_NETWORK" : "PUBLIC",
            ]);
        },
    );

    let commentIndex = 0;
    results["Comments.csv"] = writeUntil(
        join(outDir, "Comments.csv"),
        csvLine(["Date", "Link", "Message"]),
        target("Comments.csv"),
        () => {
            commentIndex += 1;
            return csvLine([
                `${randomDate()} UTC`,
                `https://www.linkedin.com/feed/update/urn:li:activity:${commentIndex}`,
                body(MESSAGE_PARTS),
            ]);
        },
    );

    return results;
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{ sizeMb: number, dir: string }}
 */
export function parseArgs(argv) {
    let sizeMb = Number.NaN;
    let dir = "";
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const value = argv[index + 1];
        if (argument === "--size-mb" && value !== undefined) {
            sizeMb = Number(value);
            index += 1;
        } else if (argument === "--dir" && value !== undefined) {
            dir = value;
            index += 1;
        } else {
            throw new Error(`invalid option: ${argument}`);
        }
    }
    return {
        sizeMb,
        dir: dir || join(tmpdir(), `linkedin-analyzer-export-${sizeMb}mb`),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parseArgs(process.argv.slice(2));
        const started = performance.now();
        const results = generateLargeExport(options);
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        for (const [file, { bytes, rows }] of Object.entries(results)) {
            const size = (bytes / MB).toFixed(1).padStart(7);
            console.log(`${file.padEnd(16)} ${size} MB ${rows} rows`);
        }
        console.log(`RESULT   WROTE dir=${resolve(options.dir)} seconds=${seconds}`);
    } catch (error) {
        console.error(`RESULT   FAILED reason=${error.message}`);
        process.exitCode = 1;
    }
}
