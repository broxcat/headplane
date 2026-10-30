import { Field as BaseField } from "@base-ui/react/field";
import { useState } from "react";

import ActionDialog from "~/components/action-dialog";
import Button from "~/components/button";
import Field, { controlClass } from "~/components/field";
import Input from "~/components/input";
import Select from "~/components/select";
import type { Guest } from "~/server/db/schema";
import { fieldValidator } from "~/utils/form";
import { localDateTime, validateAccessDate } from "~/utils/guest-access";
import type { ResourceCatalog } from "~/utils/guest-resources";

import ResourceEditor from "./resource-editor";
import { durationItems, guestFields } from "./schemas";

export default function GuestDialog({
  guest,
  catalog,
}: {
  guest?: Guest;
  catalog: ResourceCatalog;
}) {
  const [duration, setDuration] = useState<string | null>(
    guest?.requested_expires_at ? "custom" : String(guest?.requested_duration_seconds ?? "43200"),
  );
  const [timeZone, setTimeZone] = useState("UTC");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  function openChanged(open: boolean) {
    if (!open) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setTimeZone(zone);
    setDuration(
      guest?.requested_expires_at ? "custom" : String(guest?.requested_duration_seconds ?? "43200"),
    );
    const local = guest?.requested_expires_at
      ? localDateTime(guest.requested_expires_at, zone)
      : "";
    setDate(local.slice(0, 10));
    setTime(local.slice(11, 16));
  }
  const custom = duration === "custom";
  const local = `${date}T${time}`;
  const checked = custom ? validateAccessDate(local, timeZone) : null;

  return (
    <ActionDialog
      onOpenChange={openChanged}
      isDisabled={Boolean(custom && checked && "error" in checked)}
      title={guest ? "Edit guest draft" : "Add Guest"}
      description="Prepare a guest without granting VPN access. No invitation is sent. Multiple drafts may use the same email address."
      intent={guest ? "update" : "create"}
      fields={guest ? { revision: String(guest.revision) } : undefined}
      submitLabel={guest ? "Save changes" : "Create draft"}
      trigger={
        <Button variant={guest ? "secondary" : "primary"}>
          {guest ? "Edit draft" : "Add Guest"}
        </Button>
      }
    >
      <Input
        label="Email"
        name="email"
        type="email"
        required
        maxLength={254}
        defaultValue={guest?.email}
        validate={fieldValidator(guestFields.email)}
      />
      <Input
        label="Display name"
        name="display_name"
        maxLength={100}
        defaultValue={guest?.display_name ?? ""}
        validate={fieldValidator(guestFields.display_name)}
      />
      <Field label="Administrative notes" name="notes" validate={fieldValidator(guestFields.notes)}>
        <BaseField.Control
          render={<textarea />}
          className={`${controlClass} h-24 resize-y px-2.5 py-2`}
          maxLength={4000}
          defaultValue={guest?.notes ?? ""}
        />
      </Field>
      {!guest && <ResourceEditor catalog={catalog} />}
      <Select
        label="Access duration"
        name="duration"
        items={
          guest?.requested_duration_seconds === 86400
            ? [...durationItems, { value: "86400", label: "24 hours (legacy)" }]
            : durationItems
        }
        value={duration}
        onValueChange={setDuration}
        required
        description="Relative durations start only after VPN permissions are actually activated and verified. Invitation validity is separate."
      />
      <input type="hidden" name="time_zone" value={timeZone} />
      {custom && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">Access expires at</legend>
          <p className="text-muted text-xs">
            Time zone: {timeZone}. Stored in UTC. This absolute deadline must still be in the future
            when access is activated.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Date" type="date" required value={date} onChange={setDate} />
            <Input label="Time" type="time" required step={60} value={time} onChange={setTime} />
          </div>
          <Field
            label="Access expiry validation"
            labelHidden
            name="requested_expires_at"
            validate={() => (checked && "error" in checked ? checked.error : null)}
          >
            <BaseField.Control type="hidden" value={date && time ? local : ""} />
          </Field>
          {checked && "error" in checked && date && time && (
            <p role="alert" className="text-bad text-xs">
              {checked.error}
            </p>
          )}
          {checked && "date" in checked && (
            <p className="text-muted text-xs">
              UTC: {checked.date.toISOString().replace("T", " ").slice(0, 16)}
            </p>
          )}
        </fieldset>
      )}
    </ActionDialog>
  );
}
