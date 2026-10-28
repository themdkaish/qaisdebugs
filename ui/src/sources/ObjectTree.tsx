import { useEffect, useState } from 'react';
import { type PropertyDescriptor, type RemoteObject, describe, isExpandable } from '../debugger/remoteObject';

/** A lazily expanded tree over a CDP remote object, shared by the scope panel and hover tooltips. */

export interface ObjectTreeProps {
  label: string;
  objectId: string;
  getProperties: (objectId: string) => Promise<PropertyDescriptor[]>;
  depth: number;
  defaultOpen?: boolean;
}

export function ObjectTree({ label, objectId, getProperties, depth, defaultOpen }: ObjectTreeProps): JSX.Element {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [properties, setProperties] = useState<PropertyDescriptor[] | undefined>();
  const [failed, setFailed] = useState<string | undefined>();

  useEffect(() => {
    if (!open || properties) return;
    let cancelled = false;
    getProperties(objectId)
      .then((list) => {
        if (!cancelled) setProperties(list);
      })
      .catch((reason: Error) => {
        if (!cancelled) setFailed(reason.message);
      });

    return () => {
      cancelled = true;
    };
  }, [open, properties, objectId, getProperties]);

  return (
    <div>
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex w-full items-center gap-1 px-2 py-0.5 text-left font-mono hover:bg-zinc-800/60" style={{ paddingInlineStart: 8 + depth * 12 }}>
        <span className="w-3 text-zinc-500">{open ? '▾' : '▸'}</span>
        <span className="text-sky-300">{label}</span>
      </button>
      {open && failed && (
        <p className="px-2 text-amber-300" style={{ paddingInlineStart: 24 + depth * 12 }}>
          {failed}
        </p>
      )}
      {open && properties?.length === 0 && (
        <p className="px-2 text-zinc-600" style={{ paddingInlineStart: 24 + depth * 12 }}>
          empty
        </p>
      )}
      {open && properties?.map((property) => <Property key={property.name} property={property} getProperties={getProperties} depth={depth + 1} />)}
    </div>
  );
}

function Property({ property, getProperties, depth }: { property: PropertyDescriptor; getProperties: (objectId: string) => Promise<PropertyDescriptor[]>; depth: number }): JSX.Element {
  const value: RemoteObject | undefined = property.value ?? property.get;

  if (isExpandable(value) && value?.objectId) {
    return <ObjectTree label={`${property.name}: ${describe(value)}`} objectId={value.objectId} getProperties={getProperties} depth={depth} />;
  }

  return (
    <div className="flex gap-1 px-2 py-0.5 font-mono" style={{ paddingInlineStart: 24 + depth * 12 }}>
      <span className="text-sky-300">{property.name}:</span>
      <span className="min-w-0 break-all text-zinc-200">{describe(value)}</span>
    </div>
  );
}
