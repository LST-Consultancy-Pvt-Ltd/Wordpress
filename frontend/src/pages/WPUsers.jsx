import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Users, Plus, Trash2, Edit2, Loader2, RefreshCw, KeyRound, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "../components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { getSites, getWPUsers, createWPUser, updateWPUser, deleteWPUser, resetWPUserPassword } from "../lib/api";
import { toast } from "sonner";

const ROLE_COLORS = {
  administrator: "bg-red-500/10 text-red-500 border-red-500/30",
  editor: "bg-blue-500/10 text-blue-500 border-blue-500/30",
  author: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30",
  contributor: "bg-yellow-500/10 text-yellow-500 border-yellow-500/30",
  subscriber: "bg-gray-500/10 text-gray-400 border-gray-500/30",
};

const ROLES = ["administrator", "editor", "author", "contributor", "subscriber"];

const emptyForm = { username: "", email: "", password: "", role: "subscriber", first_name: "", last_name: "" };

export default function WPUsers() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [roleChanging, setRoleChanging] = useState({});
  const [deleting, setDeleting] = useState({});
  const [resetting, setResetting] = useState({});
  const [resetResult, setResetResult] = useState(null);

  useEffect(() => { loadSites(); }, []);
  useEffect(() => { if (selectedSite) loadUsers(); }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const loadUsers = async () => {
    setLoading(true);
    try {
      const r = await getWPUsers(selectedSite);
      setUsers(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load WP users");
    } finally { setLoading(false); }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      const r = await createWPUser(selectedSite, form);
      setUsers(prev => [...prev, r.data]);
      setCreateOpen(false);
      setForm(emptyForm);
      toast.success(`Created user: ${form.username}`);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to create user");
    } finally { setCreating(false); }
  };

  const handleRoleChange = async (userId, newRole) => {
    setRoleChanging(prev => ({ ...prev, [userId]: true }));
    try {
      await updateWPUser(selectedSite, userId, { role: newRole });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, roles: [newRole] } : u));
      toast.success("Role updated");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to update role");
    } finally { setRoleChanging(prev => ({ ...prev, [userId]: false })); }
  };

  const handleDelete = async (user) => {
    if (!window.confirm(`Delete user "${user.name}"? Their posts will be reassigned to admin.`)) return;
    setDeleting(prev => ({ ...prev, [user.id]: true }));
    try {
      await deleteWPUser(selectedSite, user.id);
      setUsers(prev => prev.filter(u => u.id !== user.id));
      toast.success("User deleted");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to delete user");
    } finally { setDeleting(prev => ({ ...prev, [user.id]: false })); }
  };

  const handleResetPassword = async (user) => {
    setResetting(prev => ({ ...prev, [user.id]: true }));
    try {
      const r = await resetWPUserPassword(selectedSite, user.id);
      setResetResult({ user: user.name, password: r.data.new_password });
    } catch (err) {
      toast.error(err.response?.data?.detail || "Password reset failed");
    } finally { setResetting(prev => ({ ...prev, [user.id]: false })); }
  };

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          WP Users & Roles
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Manage WordPress users, roles and permissions
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={loadUsers} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
        <Button onClick={() => setCreateOpen(true)} disabled={!selectedSite} size="sm">
          <Plus size={14} className="mr-2" />Add User
        </Button>
      </div>

      {/* Role summary */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-3 mb-6">
        {ROLES.map(role => {
          const count = users.filter(u => u.roles?.includes(role)).length;
          return (
            <Card key={role} className="stat-card py-3">
              <p className="stat-value text-lg">{count}</p>
              <p className="stat-label capitalize">{role}s</p>
            </Card>
          );
        })}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-primary" />
        </div>
      ) : (
        <Card className="content-card">
          <CardContent className="p-0">
            <ScrollArea className="h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Registered</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map(u => {
                    const role = u.roles?.[0] || "subscriber";
                    return (
                      <TableRow key={u.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                              {(u.name || "?")[0].toUpperCase()}
                            </div>
                            <div>
                              <p className="text-sm font-medium">{u.name}</p>
                              <p className="text-xs text-muted-foreground">@{u.slug}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{u.email || "—"}</TableCell>
                        <TableCell>
                          <Select value={role} onValueChange={(v) => handleRoleChange(u.id, v)}
                            disabled={roleChanging[u.id]}>
                            <SelectTrigger className="w-[140px] h-7 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLES.map(r => (
                                <SelectItem key={r} value={r}>
                                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs border ${ROLE_COLORS[r] || ""}`}>
                                    {r}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {u.registered_date ? new Date(u.registered_date).toLocaleDateString() : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Reset password"
                              disabled={resetting[u.id]} onClick={() => handleResetPassword(u)}>
                              {resetting[u.id] ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500"
                              disabled={deleting[u.id]} onClick={() => handleDelete(u)}>
                              {deleting[u.id] ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {users.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      {selectedSite ? "No users found" : "Select a site"}
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add WordPress User</DialogTitle>
            <DialogDescription>Create a new user account on your WordPress site.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>First Name</Label>
                <Input value={form.first_name} onChange={e => setForm(p => ({ ...p, first_name: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Last Name</Label>
                <Input value={form.last_name} onChange={e => setForm(p => ({ ...p, last_name: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Username *</Label>
              <Input required value={form.username} onChange={e => setForm(p => ({ ...p, username: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Email *</Label>
              <Input required type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Password *</Label>
              <Input required type="password" value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={v => setForm(p => ({ ...p, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ROLES.map(r => <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={creating}>
                {creating ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}Create User
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Password Reset Result Dialog */}
      <Dialog open={!!resetResult} onOpenChange={() => setResetResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShieldCheck size={16} className="text-primary" />Password Reset</DialogTitle>
            <DialogDescription>New password for <strong>{resetResult?.user}</strong>. Share securely.</DialogDescription>
          </DialogHeader>
          <div className="bg-muted/30 rounded p-3 font-mono text-sm border border-border">{resetResult?.password}</div>
          <DialogFooter>
            <Button onClick={() => { navigator.clipboard.writeText(resetResult?.password || ""); toast.success("Copied!"); }}>
              Copy Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
