import * as Schema from "effect/Schema";

import { dispatchLocalStorageChange, setLocalStorageItem } from "~/hooks/useLocalStorage";

/** Which tree the Files surface shows: the project workspace or the whole server host. */
export const FILES_LOCATION_STORAGE_KEY = "t3code.filesLocation";
export const FilesLocation = Schema.Literals(["project", "server"]);
export type FilesLocation = typeof FilesLocation.Type;

export function setFilesLocation(location: FilesLocation) {
  setLocalStorageItem(FILES_LOCATION_STORAGE_KEY, location, FilesLocation);
  dispatchLocalStorageChange(FILES_LOCATION_STORAGE_KEY);
}
