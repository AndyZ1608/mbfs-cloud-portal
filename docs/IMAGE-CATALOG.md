# Create Instance OS catalog metadata

The Create Instance OS catalog groups usable Glance images by the `os_distro` image property. Set `os_distro` on golden images; `os_version` and `architecture` are optional display metadata. CMP does not write or infer missing image metadata. An image without `os_distro` remains selectable under **Other**. New distro values appear automatically, even without a friendly display label in CMP.

Examples for image administrators (do not run automatically):

```sh
openstack image set --property os_distro=ubuntu --property os_version=24.04 --property architecture=x86_64 <IMAGE_ID>
openstack image set --property os_distro=windows --property os_version=2022 --property architecture=x86_64 <IMAGE_ID>
openstack image set --property os_distro=rocky --property os_version=9 --property architecture=x86_64 <IMAGE_ID>
```

The catalog only offers active images visible to the current Keystone project. Public/community images and accepted shared images remain usable; another project's private images are excluded. The selected image UUID, not the distro label, is sent to Nova for image boot or boot-from-volume.
