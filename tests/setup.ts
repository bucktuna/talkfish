import { beforeEach } from "vitest";
import { resetCloudForTests, setCloudFetchForTests } from "@/lib/lichess-cloud";
import { defaultCloudFetch } from "./cloud-mock";

beforeEach(() => {
  resetCloudForTests();
  setCloudFetchForTests(defaultCloudFetch);
});
