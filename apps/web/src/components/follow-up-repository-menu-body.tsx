import {
  RepositoryContextMenuBody,
  type RepositoryContextPickerProps,
} from "@/components/repository-picker";

export type FollowUpRepositoryPickerProps = RepositoryContextPickerProps;

/** Loaded lazily by the composer; mounted selections remain immutable via picker props. */
export function FollowUpRepositoryMenuBody(props: FollowUpRepositoryPickerProps) {
  return <RepositoryContextMenuBody {...props} />;
}
