#!/bin/bash

./configure --debug
make -C out  BUILDTYPE=Debug -j4

echo "showtime ?"

