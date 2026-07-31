const zlib = require("zlib");

// jsPDF writes each drawn line as one `(text) Tj` operator inside a content
// stream, deflated because the export asks for compression.
const STREAM_START = /stream\r?\n/g;
const PDF_STRING = /\((?:\\[\s\S]|[^\\()])*\)/g;
const ESCAPES = Object.freeze({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" });

/**
 * Undo the escaping a PDF literal string uses.
 * @param {string} literal - String including its surrounding parentheses
 * @returns {string} Decoded text
 */
function decodePdfString(literal) {
    const body = literal.slice(1, -1);
    let out = "";
    for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== "\\") {
            out += body[index];
            continue;
        }
        const next = body[index + 1];
        index += 1;
        if (ESCAPES[next]) {
            out += ESCAPES[next];
            continue;
        }
        if (next >= "0" && next <= "7") {
            const octal = body.slice(index, index + 3).match(/^[0-7]{1,3}/)[0];
            index += octal.length - 1;
            out += String.fromCharCode(parseInt(octal, 8));
            continue;
        }
        out += next;
    }
    return out;
}

/**
 * Read the text a PDF actually draws.
 *
 * Only works for documents drawn with the core fonts: an embedded TrueType
 * subset is written as glyph ids, which say nothing without walking the font's
 * ToUnicode map per resource. The export falls back to Helvetica when the font
 * files cannot be fetched, which is how the spec makes the text readable.
 * @param {Buffer} bytes - Raw PDF file
 * @returns {string} Every drawn string, newline separated
 */
function extractPdfText(bytes) {
    const raw = bytes.toString("latin1");
    const drawn = [];

    STREAM_START.lastIndex = 0;
    let match = STREAM_START.exec(raw);
    while (match !== null) {
        const start = match.index + match[0].length;
        const end = raw.indexOf("endstream", start);
        if (end > start) {
            const slice = Buffer.from(raw.slice(start, end), "latin1");
            let content = "";
            try {
                content = zlib.inflateSync(slice).toString("latin1");
            } catch {
                content = slice.toString("latin1");
            }
            for (const literal of content.match(PDF_STRING) || []) {
                drawn.push(decodePdfString(literal));
            }
        }
        match = STREAM_START.exec(raw);
    }

    return drawn.join("\n");
}

module.exports = { extractPdfText };
