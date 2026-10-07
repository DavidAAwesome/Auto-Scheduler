import { useEffect, useRef, useState } from "react";
import type { Task } from "../types/models";

export default function PlanWorkTime({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  useEffect(() => {
    dialog.current?.showModal();

    return () => {
      dialog.current?.close();
    };
  }, []);
function setDuration(durationMinutes: number) {
  if (!startTime) return;

  const [hours, minutes] = startTime.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes + durationMinutes, 0, 0);

  const newEndTime =
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0");

  setEndTime(newEndTime);
}
  return (
    <dialog
      ref={dialog}
      className="task-dialog"
      aria-labelledby="plan-work-title"
    >
      <form method="dialog">
        <div className="task-dialog-heading">
          <div>
            <p className="eyebrow">PLAN WORK TIME</p>
            <h2 id="plan-work-title">Plan work time</h2>
          </div>
        </div>

        <div className="plan-work-fields">
       <div className="plan-work-fields">
         <label>
           Task
           <input value={task.title} disabled />
         </label>

         <label>
           Day
           <input type="date" name="day" required />
         </label>
       </div>
    </div>
        <div className="plan-time-row">
          <label>
            From
           <input
             type="time"
             name="startTime"
             value={startTime}
             onChange={(e) => setStartTime(e.target.value)}
             required
           /> 
          </label>

          <label>
            Until
         <input
           type="time"
           name="endTime"
           value={endTime}
           onChange={(e) => setEndTime(e.target.value)}
           required
         />   
          </label>
        </div>
      <div className="plan-quick-times">
  <button
    type="button"
    className="button secondary"
    onClick={() => setDuration(30)}
  >
    30m
  </button>

  <button
    type="button"
    className="button secondary"
    onClick={() => setDuration(60)}
  >
    1h
  </button>

  <button
    type="button"
    className="button secondary"
    onClick={() => setDuration(90)}
  >
    1h30m
  </button>

  <button
    type="button"
    className="button secondary"
    onClick={() => setDuration(120)}
  >
    2h
  </button>
</div>

        <div className="task-dialog-footer">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>

          <button className="button" type="submit">
            Plan session
          </button>
        </div>
      </form>
    </dialog>
  );
}