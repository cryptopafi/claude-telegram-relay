import { expect, test } from "bun:test";
import { subtitlesToPlainText } from "./url-handler";

test("subtitlesToPlainText strips WEBVTT markup and timestamps", () => {
  const vtt = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello <c.colorE5E5E5>world</c>\n\n00:00:02.100 --> 00:00:04.000\n[Music] this is a test`;
  const text = subtitlesToPlainText(vtt);
  expect(text).toBe("Hello world this is a test");
});

test("subtitlesToPlainText strips SRT numbering and timestamps", () => {
  const srt = `1\n00:00:00,000 --> 00:00:01,500\nSalut!\n\n2\n00:00:02,000 --> 00:00:03,000\nCe faci?`;
  const text = subtitlesToPlainText(srt);
  expect(text).toBe("Salut! Ce faci?");
});
