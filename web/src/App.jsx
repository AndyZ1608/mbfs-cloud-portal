import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Instances from './pages/Instances.jsx';
import Volumes from './pages/Volumes.jsx';
import Networks from './pages/Networks.jsx';
import FloatingIPs from './pages/FloatingIPs.jsx';
import SecurityGroups from './pages/SecurityGroups.jsx';
import Images from './pages/Images.jsx';
import Keypairs from './pages/Keypairs.jsx';
import Billing from './pages/Billing.jsx';
import LoadBalancers from './pages/LoadBalancers.jsx';
import Backup from './pages/Backup.jsx';
import AuditLog from './pages/AuditLog.jsx';
import Optimize from './pages/Optimize.jsx';
import PowerSchedule from './pages/PowerSchedule.jsx';
import ObjectStorage from './pages/ObjectStorage.jsx';
import Marketplace from './pages/Marketplace.jsx';
import K8sClusters from './pages/K8sClusters.jsx';
import Admin from './pages/Admin.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="/instances" element={<Instances />} />
          <Route path="/marketplace" element={<Marketplace />} />
          <Route path="/kubernetes" element={<K8sClusters />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/volumes" element={<Volumes />} />
          <Route path="/networks" element={<Networks />} />
          <Route path="/floating-ips" element={<FloatingIPs />} />
          <Route path="/security-groups" element={<SecurityGroups />} />
          <Route path="/images" element={<Images />} />
          <Route path="/keypairs" element={<Keypairs />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/usage" element={<Navigate to="/billing" replace />} />
          <Route path="/load-balancers" element={<LoadBalancers />} />
          <Route path="/backup" element={<Backup />} />
          <Route path="/audit" element={<AuditLog />} />
          <Route path="/optimize" element={<Optimize />} />
          <Route path="/power" element={<PowerSchedule />} />
          <Route path="/object-storage" element={<ObjectStorage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
