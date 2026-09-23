import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import useCmpSession from '../useCmpSession.js';
import VncConsole from '../components/VncConsole.jsx';

export default function ConsolePage() {
  const { instanceId } = useParams();
  const session = useCmpSession();
  const [server, setServer] = useState(null);
  const name = server?.id === instanceId ? server.name : instanceId;

  useEffect(() => {
    if (!session) return;
    let active = true;
    api(`/servers/${encodeURIComponent(instanceId)}`)
      .then((data) => { if (active) setServer({ id: instanceId, name: data.server?.name || instanceId }); })
      .catch(() => { /* The console endpoint handles access errors; keep the UUID as the title. */ });
    return () => { active = false; };
  }, [instanceId, session]);

  useEffect(() => {
    const previous = document.title;
    document.title = `Console — ${name}`;
    return () => { document.title = previous; };
  }, [name]);

  if (!session) return <div className="boot">Đang tải…</div>;
  return <VncConsole key={instanceId} instanceId={instanceId} name={name} />;
}
