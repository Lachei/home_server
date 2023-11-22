#pragma once

#define check_res(res) {auto t = res; if(t) {std::cout << "Error occured with value: " << t << std::endl ;return t;}}