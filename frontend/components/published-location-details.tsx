"use client";

import { Fragment, useSyncExternalStore } from "react";
import catalogJson from "../../data/campus-places.json";
import type { LocationFeature } from "@/lib/place-types";
import { isMappedPoint } from "@/lib/place-types";

type Hours = {
  periods: {
    label: string;
    from: string | null;
    to: string | null;
    rawText?: string;
    weekly: Record<string, string[][]>;
  }[];
};
type Destination = {
  id: string;
  name: string;
  roomId?: string;
  buildingCode?: string | null;
  parentId?: string;
  aliases?: string[];
  status?: string;
  hours?: Hours;
};
type Room = { id: string; code: string; buildingCode: string; floor: number };
const catalog = catalogJson as unknown as {
  buildingNames: Record<string, string>;
  rooms: Room[];
  destinations: Destination[];
};
const destinations = new Map(catalog.destinations.map((destination) => [destination.id, destination]));
const rooms = new Map(catalog.rooms.map((room) => [room.id, room]));

function destinationRoom(destination?: Destination): Room | undefined {
  if (!destination) return undefined;
  return destination.roomId ? rooms.get(destination.roomId) : destinationRoom(destinations.get(destination.parentId ?? ""));
}
function statusLabel(status?: string) {
  if (status === "closed_permanently") return "Permanently closed";
  if (status === "closed_temporarily") return "Temporarily closed";
  if (status === "open") return "Operating · check published hours";
  return "Service status awaiting confirmation";
}
function getCampusDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function subscribeDate(callback: () => void) {
  const timer = window.setInterval(callback, 60000);
  return () => window.clearInterval(timer);
}
function serverDate() { return ""; }

function PublishedHours({ destination, date, showNotice = true }: { destination: Destination; date: string; showNotice?: boolean }) {
  const periods = date ? destination.hours?.periods.filter((period) => (!period.from || period.from <= date) && (!period.to || date <= period.to)) : [];
  if (!periods?.length) return <><strong>Current hours are awaiting confirmation.</strong>{showNotice && <p>Toronto time. Unlisted days and special closures need confirmation.</p>}</>;
  const dayLabels: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  return <div>
    {periods.map((period, index) => <div key={`${period.label}-${index}`}>
      <p>{period.label}</p>
      <strong>{(period.rawText ? period.rawText.split(/\r?\n/) : Object.entries(period.weekly).map(([day, intervals]) => `${dayLabels[day] ?? day}: ${intervals.length ? intervals.map((interval) => interval.join("–")).join(", ") : "Closed"}`)).map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{line}</Fragment>)}</strong>
    </div>)}
    {showNotice && <p>Toronto time. Unlisted days and special closures need confirmation.</p>}
  </div>;
}

export default function PublishedLocationDetails({ feature }: { feature: LocationFeature }) {
  const date = useSyncExternalStore(subscribeDate, getCampusDate, serverDate);
  const destination = destinations.get(feature.properties.id);
  if (!destination) return null;
  const room = destinationRoom(destination);
  const buildingCode = room?.buildingCode ?? destination.buildingCode;
  const children = catalog.destinations.filter((child) => child.parentId === destination.id);
  return <>
    <div className="info-row"><span>Campus location</span><strong>{room ? `Room ${room.code}` : "Room awaiting confirmation"}</strong>{buildingCode && <p>{catalog.buildingNames[buildingCode] ?? `${buildingCode} Building`}{room ? ` · Floor ${room.floor}` : ""}</p>}</div>
    <div className="info-row"><span>Service status</span><strong>{statusLabel(destination.status)}</strong></div>
    {!isMappedPoint(feature) && <div className="info-row"><span>Map position</span><strong>Awaiting confirmation</strong></div>}
    {destination.aliases?.length && <div className="info-row"><span>Also find this service as</span><strong>{destination.aliases.join(" · ")}</strong></div>}
    <div className="info-row"><span>Published hours</span><PublishedHours destination={destination} date={date} /></div>
    {children.map((child) => <div className="info-row" key={child.id}><span>{child.name}</span><strong>{statusLabel(child.status ?? destination.status)}</strong><PublishedHours destination={child} date={date} showNotice={false} /></div>)}
  </>;
}
