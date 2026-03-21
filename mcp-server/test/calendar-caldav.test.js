import { describe, expect, it } from "vitest";
import ICAL from "ical.js";
import { createCalDAVCalendarHandler } from "../../lib/handlers/calendar-caldav.js";

const BASE_CONFIG = {
  caldavUsername: "test@example.com",
  caldavPassword: "app-specific-password",
};

function makeClient({ calendars, objectsByUrl, expandedObjectsByUrl = null }) {
  return {
    async fetchCalendars() {
      return calendars;
    },
    async fetchCalendarObjects({ calendar, objectUrls, expand }) {
      if (expand && !objectUrls) {
        const source = expandedObjectsByUrl || objectsByUrl;
        return [...source.values()].filter((object) => !calendar || object.url.startsWith(calendar.url));
      }

      return (objectUrls || []).map((url) => {
        const object = objectsByUrl.get(url);
        if (!object) return null;
        if (calendar && !url.startsWith(calendar.url)) return null;
        return object;
      }).filter(Boolean);
    },
    async updateCalendarObject({ calendarObject }) {
      objectsByUrl.set(calendarObject.url, {
        ...objectsByUrl.get(calendarObject.url),
        ...calendarObject,
      });
      return { ok: true, status: 204 };
    },
    async createCalendarObject({ calendar, filename, iCalString }) {
      const url = new URL(filename, calendar.url).href;
      objectsByUrl.set(url, {
        url,
        etag: "created",
        data: iCalString,
      });
      return { ok: true, status: 201 };
    },
    async deleteCalendarObject() {
      throw new Error("unexpected delete call");
    },
  };
}

describe("createCalDAVCalendarHandler", () => {
  it("formats exdate using the master dtstart timezone form", async () => {
    const calendar = { displayName: "Daily Plan", url: "https://example.com/daily/" };
    const objectUrl = `${calendar.url}bangkok-series.ics`;
    const occurrenceKey = "20260331T020000Z";
    const object = {
      url: objectUrl,
      etag: "1",
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//en
BEGIN:VEVENT
UID:bangkok-series
DTSTAMP:20260321T010000Z
DTSTART;TZID=Asia/Bangkok:20260325T090000
DTEND;TZID=Asia/Bangkok:20260325T093000
RRULE:FREQ=WEEKLY;COUNT=4
SUMMARY:Bangkok series
END:VEVENT
BEGIN:VEVENT
UID:bangkok-series
RECURRENCE-ID:20260331T020000Z
DTSTAMP:20260321T010000Z
DTSTART:20260331T020000Z
DTEND:20260331T023000Z
SUMMARY:Bangkok series
END:VEVENT
END:VCALENDAR`,
    };
    const objectsByUrl = new Map([[objectUrl, object]]);
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars: [calendar], objectsByUrl }),
    });

    const result = await handler({
      action: "delete",
      id: `${objectUrl}#${encodeURIComponent(occurrenceKey)}`,
    });

    expect(result.success).toBe(true);

    const updated = ICAL.Component.fromString(objectsByUrl.get(objectUrl).data);
    const master = updated.getFirstSubcomponent("vevent");
    const exdate = master.getFirstProperty("exdate");
    expect(exdate.getFirstParameter("TZID") || exdate.getFirstParameter("tzid")).toBe("Asia/Bangkok");
    expect(exdate.getFirstValue().toICALString()).toBe("20260331T090000");
  });

  it("deletes this and future recurring occurrences by truncating the series", async () => {
    const calendar = { displayName: "Daily Plan", url: "https://example.com/daily/" };
    const objectUrl = `${calendar.url}run.ics`;
    const occurrenceKey = "20260325T083000Z";
    const object = {
      url: objectUrl,
      etag: "1",
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//en
BEGIN:VEVENT
UID:run-series
DTSTAMP:20260321T010000Z
DTSTART:20260323T083000Z
DTEND:20260323T090000Z
RRULE:FREQ=DAILY;COUNT=5
SUMMARY:Run
END:VEVENT
BEGIN:VEVENT
UID:run-series
RECURRENCE-ID:20260325T083000Z
DTSTAMP:20260321T010000Z
DTSTART:20260325T100000Z
DTEND:20260325T103000Z
SUMMARY:Moved run
END:VEVENT
END:VCALENDAR`,
    };
    const objectsByUrl = new Map([[objectUrl, object]]);
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars: [calendar], objectsByUrl }),
    });

    const result = await handler({
      action: "delete",
      id: `${objectUrl}#${encodeURIComponent(occurrenceKey)}`,
      futureEvents: true,
    });

    expect(result.success).toBe(true);
    expect(result.deletedEvent.id).toBe(`${objectUrl}#${encodeURIComponent(occurrenceKey)}`);

    const updated = ICAL.Component.fromString(objectsByUrl.get(objectUrl).data);
    const master = updated.getAllSubcomponents("vevent").find((component) => !component.hasProperty("recurrence-id"));
    const recur = master.getFirstPropertyValue("rrule").toJSON();
    expect(recur.count).toBeUndefined();
    expect(recur.until).toBe("2026-03-25T08:29:59Z");
    expect(
      updated
        .getAllSubcomponents("vevent")
        .some((component) => component.getFirstPropertyValue("recurrence-id")?.toICALString() === occurrenceKey)
    ).toBe(false);
  });

  it("creates single-day all-day events with an exclusive next-day end", async () => {
    const calendar = { displayName: "Daily Plan", url: "https://example.com/daily/" };
    const objectsByUrl = new Map();
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars: [calendar], objectsByUrl }),
    });

    const result = await handler({
      action: "create",
      title: "Holiday",
      start: "2026-03-23",
      allDay: true,
    });

    expect(result.success).toBe(true);
    expect(result.event.isAllDay).toBe(true);

    const created = [...objectsByUrl.values()][0];
    const vevent = ICAL.Component.fromString(created.data).getFirstSubcomponent("vevent");
    expect(vevent.getFirstPropertyValue("dtstart").toICALString()).toBe("20260323");
    expect(vevent.getFirstPropertyValue("dtend").toICALString()).toBe("20260324");
  });

  it("allows update to switch an event to all-day", async () => {
    const calendar = { displayName: "Daily Plan", url: "https://example.com/daily/" };
    const objectUrl = `${calendar.url}lunch.ics`;
    const object = {
      url: objectUrl,
      etag: "1",
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//en
BEGIN:VEVENT
UID:lunch
DTSTAMP:20260321T010000Z
DTSTART:20260323T120000Z
DTEND:20260323T130000Z
SUMMARY:Lunch
END:VEVENT
END:VCALENDAR`,
    };
    const objectsByUrl = new Map([[objectUrl, object]]);
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars: [calendar], objectsByUrl }),
    });

    const result = await handler({
      action: "update",
      id: objectUrl,
      allDay: true,
    });

    expect(result.success).toBe(true);
    expect(result.event.isAllDay).toBe(true);

    const updated = ICAL.Component.fromString(objectsByUrl.get(objectUrl).data);
    const vevent = updated.getFirstSubcomponent("vevent");
    expect(vevent.getFirstPropertyValue("dtstart").isDate).toBe(true);
    expect(vevent.getFirstPropertyValue("dtend").isDate).toBe(true);
    expect(vevent.getFirstPropertyValue("dtstart").toICALString()).toBe("20260323");
    expect(vevent.getFirstPropertyValue("dtend").toICALString()).toBe("20260324");
  });

  it("preserves duration when rescheduling a timed event by start only", async () => {
    const calendar = { displayName: "Daily Plan", url: "https://example.com/daily/" };
    const objectUrl = `${calendar.url}consult.ics`;
    const object = {
      url: objectUrl,
      etag: "1",
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//en
BEGIN:VEVENT
UID:consult
DTSTAMP:20260321T010000Z
DTSTART:20260325T090000Z
DTEND:20260325T094500Z
SUMMARY:Consult
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Reminder
TRIGGER:-PT15M
END:VALARM
END:VEVENT
END:VCALENDAR`,
    };
    const objectsByUrl = new Map([[objectUrl, object]]);
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars: [calendar], objectsByUrl }),
    });

    const result = await handler({
      action: "update",
      id: objectUrl,
      start: "2026-03-25T11:00:00Z",
    });

    expect(result.success).toBe(true);

    const updated = ICAL.Component.fromString(objectsByUrl.get(objectUrl).data);
    const vevent = updated.getFirstSubcomponent("vevent");
    expect(vevent.getFirstPropertyValue("dtstart").toICALString()).toBe("20260325T110000Z");
    expect(vevent.getFirstPropertyValue("dtend").toICALString()).toBe("20260325T114500Z");
    expect(vevent.getAllSubcomponents("valarm")).toHaveLength(1);
  });

  it("supports start plus duration updates without needing an explicit end", async () => {
    const calendar = { displayName: "Daily Plan", url: "https://example.com/daily/" };
    const objectUrl = `${calendar.url}focus.ics`;
    const object = {
      url: objectUrl,
      etag: "1",
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//en
BEGIN:VEVENT
UID:focus
DTSTAMP:20260321T010000Z
DTSTART:20260325T090000Z
DTEND:20260325T094500Z
SUMMARY:Focus
END:VEVENT
END:VCALENDAR`,
    };
    const objectsByUrl = new Map([[objectUrl, object]]);
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars: [calendar], objectsByUrl }),
    });

    const result = await handler({
      action: "update",
      id: objectUrl,
      start: "2026-03-25T11:00:00Z",
      duration: 30,
    });

    expect(result.success).toBe(true);

    const updated = ICAL.Component.fromString(objectsByUrl.get(objectUrl).data);
    const vevent = updated.getFirstSubcomponent("vevent");
    expect(vevent.getFirstPropertyValue("dtstart").toICALString()).toBe("20260325T110000Z");
    expect(vevent.getFirstPropertyValue("dtend").toICALString()).toBe("20260325T113000Z");
  });

  it("deletes a server-expanded recurring occurrence without requiring object-url expansion", async () => {
    const calendar = { displayName: "Daily Plan", url: "https://example.com/daily/" };
    const objectUrl = `${calendar.url}server-expanded.ics`;
    const occurrenceKey = "20260409T020000Z";
    const object = {
      url: objectUrl,
      etag: "1",
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//en
BEGIN:VEVENT
UID:server-expanded
DTSTAMP:20260321T010000Z
DTSTART:20260407T020000Z
DTEND:20260407T023000Z
RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4
SUMMARY:Server expanded
END:VEVENT
END:VCALENDAR`,
    };
    const expandedObject = {
      url: objectUrl,
      etag: "1",
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//en
BEGIN:VEVENT
UID:server-expanded
RECURRENCE-ID:20260407T020000Z
DTSTAMP:20260321T010000Z
DTSTART:20260407T020000Z
DTEND:20260407T023000Z
SUMMARY:Server expanded
END:VEVENT
BEGIN:VEVENT
UID:server-expanded
RECURRENCE-ID:20260409T020000Z
DTSTAMP:20260321T010000Z
DTSTART:20260409T020000Z
DTEND:20260409T023000Z
SUMMARY:Server expanded
END:VEVENT
BEGIN:VEVENT
UID:server-expanded
RECURRENCE-ID:20260414T020000Z
DTSTAMP:20260321T010000Z
DTSTART:20260414T020000Z
DTEND:20260414T023000Z
SUMMARY:Server expanded
END:VEVENT
BEGIN:VEVENT
UID:server-expanded
RECURRENCE-ID:20260416T020000Z
DTSTAMP:20260321T010000Z
DTSTART:20260416T020000Z
DTEND:20260416T023000Z
SUMMARY:Server expanded
END:VEVENT
END:VCALENDAR`,
    };
    const objectsByUrl = new Map([[objectUrl, object]]);
    const expandedObjectsByUrl = new Map([[objectUrl, expandedObject]]);
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars: [calendar], objectsByUrl, expandedObjectsByUrl }),
    });

    const result = await handler({
      action: "delete",
      id: `${objectUrl}#${encodeURIComponent(occurrenceKey)}`,
    });

    expect(result.success).toBe(true);
    expect(result.deletedEvent.id).toBe(`${objectUrl}#${encodeURIComponent(occurrenceKey)}`);

    const updated = ICAL.Component.fromString(objectsByUrl.get(objectUrl).data);
    const master = updated.getFirstSubcomponent("vevent");
    expect(master.getAllProperties("exdate").map((property) => property.getFirstValue().toICALString())).toContain(occurrenceKey);
  });

  it("deletes a single recurring occurrence without treating absence as an error", async () => {
    const calendar = { displayName: "Daily Plan", url: "https://example.com/daily/" };
    const objectUrl = `${calendar.url}standup.ics`;
    const occurrenceKey = "20260325T083000Z";
    const object = {
      url: objectUrl,
      etag: "1",
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//en
BEGIN:VEVENT
UID:standup
DTSTAMP:20260321T010000Z
DTSTART:20260323T083000Z
DTEND:20260323T090000Z
RRULE:FREQ=DAILY;COUNT=4
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:standup
RECURRENCE-ID:20260325T083000Z
DTSTAMP:20260321T010000Z
DTSTART:20260325T100000Z
DTEND:20260325T103000Z
SUMMARY:Standup moved
END:VEVENT
END:VCALENDAR`,
    };
    const objectsByUrl = new Map([[objectUrl, object]]);
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars: [calendar], objectsByUrl }),
    });

    const result = await handler({
      action: "delete",
      id: `${objectUrl}#${encodeURIComponent(occurrenceKey)}`,
    });

    expect(result.success).toBe(true);
    expect(result.deletedEvent.id).toBe(`${objectUrl}#${encodeURIComponent(occurrenceKey)}`);

    const updated = ICAL.Component.fromString(objectsByUrl.get(objectUrl).data);
    const master = updated.getFirstSubcomponent("vevent");
    expect(master.getAllProperties("exdate").map((property) => property.getFirstValue().toICALString())).toContain(occurrenceKey);
    expect(
      updated
        .getAllSubcomponents("vevent")
        .some((component) => component.getFirstPropertyValue("recurrence-id")?.toICALString() === occurrenceKey)
    ).toBe(false);
  });

  it("does not silently default to an arbitrary calendar when Daily Plan and Shared are absent", async () => {
    const calendar = { displayName: "Work", url: "https://example.com/work/" };
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars: [calendar], objectsByUrl: new Map() }),
    });

    await expect(handler({
      action: "create",
      title: "Test",
      start: "2026-03-23 10:00",
    })).rejects.toThrow("no default writable icloud calendar found. specify calendar explicitly.");
  });

  it("reports non-commitment calendars as non-writable in list output", async () => {
    const calendars = [
      { displayName: "Work", url: "https://example.com/work/" },
      { displayName: "Shared", url: "https://example.com/shared/" },
    ];
    const handler = createCalDAVCalendarHandler(BASE_CONFIG, {
      client: makeClient({ calendars, objectsByUrl: new Map() }),
    });

    const result = await handler({ action: "list" });

    expect(result.calendars).toEqual([
      expect.objectContaining({ title: "Work", allowsModifications: false }),
      expect.objectContaining({ title: "Shared", allowsModifications: true }),
    ]);
  });
});
