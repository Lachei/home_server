#!/bin/bash
# script to update the admin passwort of the server

echo Insert the Salt \(has to be 10 digits long, only use numbers\)
read salt

while [ ${#salt} -ne 10 ] ; do
    echo The number of digits for the salt was wrong. Insert 10 digits for the salt
    read salt
done

echo Input password:
read -s password
echo Repeat password:
read -s password_rep

while [[ ${password} != ${password_rep} ]] ; do
    echo The passwords were not the same 
    echo Input password:
    read -s password
    echo Repeat password:
    read -s password_rep
done

echo Writing admin credentials file...
# getting the sha and writing it to a file
echo "${salt}" > credentials/admin
# appending the sha of the password
echo -n "${password}${salt}" | sha256sum >> credentials/admin
echo Done
