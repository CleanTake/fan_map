export type ReportStatus = "open" | "resolved";
export type ReportFilter = ReportStatus | "all";

export type LocationReport = {
  id: number;
  locationId: string;
  locationName: string;
  message: string;
  reporterType: "guest" | "registered";
  status: ReportStatus;
  createdAt: number;
  updatedAt: number;
};

export type ReportPage = {
  reports: LocationReport[];
  page: number;
  pageCount: number;
  total: number;
  counts: { open: number; resolved: number };
};
