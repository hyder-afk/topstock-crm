// What the app's own pickers pass to `onChange`: the part of a native change event that call sites read
// (`e.target.value`, sometimes `e.target.name`). A call site written for <select> or <input type="date"> keeps working
// unchanged. Components declare `onChange` with method syntax, so a handler typed for
// React.ChangeEvent<HTMLSelectElement | HTMLInputElement> is also accepted (it only reads target.value).
export type PickerChangeEvent = {
  target: { name: string; value: string };
  currentTarget: { name: string; value: string };
};

export function pickerChangeEvent(name: string | undefined, value: string): PickerChangeEvent {
  const target = { name: name ?? "", value };
  return { target, currentTarget: target };
}
