#!/bin/bash
# script to set the password for a user

echo Insert the Username
read username

while [ -z "$username" ] ; do
    echo Empty username is not allowed
    read username
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

# calculating the sha
sha=$(echo -n "$username:user@minifuziserver.duckdns.org:$password" | openssl sha256 | awk '{print $2;}')

echo Writing password for $username
# make sure json is valid
cat credentials/cred.json | jq > /dev/null || (echo "Invalid cred.json, please repair or generate with empty object" && exit 1)
# writing the username sha
cat credentials/cred.json | jq ".$username={\"sha256\":\"$sha\"}" > cred.json.tmp && mv cred.json.tmp credentials/cred.json
echo Done
