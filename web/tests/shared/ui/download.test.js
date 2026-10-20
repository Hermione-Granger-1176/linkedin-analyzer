import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadBlob } from "../../../src/shared/ui/download.js";

describe("downloadBlob", () => {
    beforeEach(() => {
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:file");
        vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("clicks a link to the blob under the file name and releases it", () => {
        const clicked = [];
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
            clicked.push({
                href: this.getAttribute("href"),
                download: this.download,
                attached: document.body.contains(this),
            });
        });

        downloadBlob(new Blob(["x"]), "report.pdf");

        expect(clicked).toEqual([{ href: "blob:file", download: "report.pdf", attached: true }]);
        expect(document.body.querySelector("a")).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
    });

    it("releases the link and the object URL when the click throws", () => {
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
            throw new Error("blocked");
        });

        expect(() => downloadBlob(new Blob(["x"]), "report.pdf")).toThrow("blocked");

        expect(document.body.querySelector("a")).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
    });

    it("still releases the object URL when the link could not be attached", () => {
        vi.spyOn(document.body, "appendChild").mockImplementation(() => {
            throw new Error("detached");
        });

        expect(() => downloadBlob(new Blob(["x"]), "report.pdf")).toThrow("detached");

        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
    });
});
