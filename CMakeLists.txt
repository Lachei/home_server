cmake_minimum_required(VERSION 3.15.0 FATAL_ERROR)
project(home_server)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED TRUE)

file(GLOB SRC "src/*.cpp" "src/*.hpp" "src/*.h" "src/diff_match_patch/diff_match_patch.cpp")
if(NOT WIN32)
    add_compile_options(-fpermissive)
endif()
add_executable(home_server ${SRC})
# keep-alive connections waiting for their next request are parked in an event loop instead of blocking a worker thread
target_compile_definitions(home_server PRIVATE CPPHTTPLIB_KEEPALIVE_PARKING=true)

find_package(Threads REQUIRED)
target_link_libraries(home_server PRIVATE Threads::Threads)

# ---------------------------------------------------------------------------------------------------
# OpenSSL
# ---------------------------------------------------------------------------------------------------
if (${CMAKE_CXX_COMPILER} STREQUAL "/usr/bin/aarch64-linux-gnu-g++")
    message("Setting cpu capabilities for the raspberry pi")
    set(CMAKE_CXX_FLAGS "-mtune=cortex-a76 ${CMAKE_CXX_FLAGS}")
    set(CMAKE_C_FLAGS "-mtune=cortex-a76 ${CMAKE_C_FLAGS}")
    set(CMAKE_SYSTEM_PROCESSOR "aarch64")
    string(REPLACE "g++" "" COMPILER_PREFIX ${CMAKE_CXX_COMPILER})

    include(FetchContent)
    set(FETCHCONTENT_QUIET FALSE)

    set(CMAKE_VERBOSE_MAKEFILE TRUE)
    set(BUILD_OPENSSL ON CACHE BOOL "Automated OpenSSL building" FORCE)
    set(CROSS ON CACHE BOOL "" FORCE)
    set(CROSS_TARGET "linux-aarch64" CACHE STRING "Compiling for aarch64" FORCE)
    set(CROSS_PREFIX "${COMPILER_PREFIX}" CACHE STRING "" FORCE)
    set(OPENSSL_BUILD_VERSION "3.0.8" CACHE STRING "" FORCE)
    FetchContent_Declare(openssl
        GIT_REPOSITORY https://github.com/viaduck/openssl-cmake.git
        GIT_PROGRESS TRUE
    )
    FetchContent_MakeAvailable(openssl)
    target_link_libraries(home_server PRIVATE -static ssl crypto ssl_lib crypto_lib)
    include_directories(${openssl_BINARY_DIR}/include)
    set(CMAKE_VERBOSE_MAKEFILE FALSE)
    # No compression for the cross build: without a sysroot the "if available" checks of cpp-httplib find the
    # host (x86) libraries, which can not be linked (statically) into the aarch64 binary
    set(HTTPLIB_USE_ZLIB_IF_AVAILABLE OFF)
    set(HTTPLIB_USE_BROTLI_IF_AVAILABLE OFF)
    set(HTTPLIB_USE_ZSTD_IF_AVAILABLE OFF)
    # Same for OpenSSL: cpp-httplib would find and link the host libssl.so. cpp-httplib is header only, so https
    # support is enabled here directly and uses the OpenSSL built above
    set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF)
    target_compile_definitions(home_server PRIVATE CPPHTTPLIB_OPENSSL_SUPPORT)
else()
    find_package(OpenSSL REQUIRED)
    target_link_libraries(home_server PRIVATE OpenSSL::SSL OpenSSL::Crypto)
endif()

# ---------------------------------------------------------------------------------------------------
# cpp-httplib, searched in this order:
#   1. find_package(httplib) (an installed cpp-httplib)
#   2. the source directory given by CPPHTTPLIB_PATH (cmake variable or environment variable)
#   3. ../cpp-httplib next to this repository
# For 2. and 3. the cpp-httplib source tree is added with add_subdirectory, so its own CMakeLists.txt is used
# ---------------------------------------------------------------------------------------------------
set(CPPHTTPLIB_PATH "$ENV{CPPHTTPLIB_PATH}" CACHE PATH "Source directory of cpp-httplib (containing its CMakeLists.txt)")
find_package(httplib CONFIG QUIET)
if (httplib_FOUND)
    message(STATUS "Using cpp-httplib ${httplib_VERSION} from find_package: ${httplib_DIR}")
    if (NOT HTTPLIB_IS_USING_OPENSSL)
        message(WARNING "The found cpp-httplib was built without OpenSSL, the server will not support https")
    endif()
else()
    if (CPPHTTPLIB_PATH)
        set(_httplib_source_dir "${CPPHTTPLIB_PATH}")
    else()
        set(_httplib_source_dir "${CMAKE_CURRENT_SOURCE_DIR}/../cpp-httplib")
    endif()
    get_filename_component(_httplib_source_dir "${_httplib_source_dir}" ABSOLUTE)
    if (NOT EXISTS "${_httplib_source_dir}/CMakeLists.txt")
        message(FATAL_ERROR "cpp-httplib not found. Install it, set CPPHTTPLIB_PATH to the cpp-httplib source directory "
                            "or put cpp-httplib into ${CMAKE_CURRENT_SOURCE_DIR}/../cpp-httplib (searched: ${_httplib_source_dir})")
    endif()
    message(STATUS "Using cpp-httplib sources from ${_httplib_source_dir}")
    set(HTTPLIB_INSTALL OFF CACHE BOOL "" FORCE) # do not install cpp-httplib together with the home server
    if (TARGET OpenSSL::SSL) # https support is mandatory when OpenSSL was found above (not for the cross build)
        set(HTTPLIB_REQUIRE_OPENSSL ON CACHE BOOL "" FORCE)
    endif()
    add_subdirectory("${_httplib_source_dir}" "${CMAKE_CURRENT_BINARY_DIR}/cpp-httplib" EXCLUDE_FROM_ALL)
endif()
target_link_libraries(home_server PRIVATE httplib::httplib)

include(CTest)
add_subdirectory(tests)
